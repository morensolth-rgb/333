/*
 * gg-mem — GameGuardian-style memory tool for FridaCtl
 *
 * Uses ptrace + process_vm_readv/writev syscalls to read/write game memory.
 * ptrace ATTACH stops the game thread cleanly (no freeze/stutter).
 *
 * NOTE: process_vm_readv/writev are invoked via syscall() directly because
 * the Android NDK does not expose them in its libc headers for minSdk < 23.
 * We define them manually using the Linux syscall numbers for arm64.
 *
 * Usage:
 *   gg-mem scan   <pid> <type> <value>           -> prints: ADDR VALUE per line
 *   gg-mem rescan <pid> <type> [addr,addr,...]   -> reads current values
 *   gg-mem write  <pid> <type> <addr> <value>    -> write value to addr
 *   gg-mem read   <pid> <type> <addr>            -> read value at addr
 *
 * Types: int32 int64 float double
 *
 * Exit codes: 0=ok, 1=error
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/ptrace.h>
#include <sys/wait.h>
#include <sys/uio.h>
#include <sys/types.h>
#include <sys/syscall.h>

/* ─── process_vm_readv/writev via syscall (NDK doesn't expose these) ──────── */
/* ARM64 syscall numbers */
#ifndef __NR_process_vm_readv
#define __NR_process_vm_readv  270
#endif
#ifndef __NR_process_vm_writev
#define __NR_process_vm_writev 271
#endif

static ssize_t gg_process_vm_readv(pid_t pid,
                                    const struct iovec *lvec, unsigned long liovcnt,
                                    const struct iovec *rvec, unsigned long riovcnt,
                                    unsigned long flags) {
    return (ssize_t)syscall(__NR_process_vm_readv, (long)pid,
                            lvec, liovcnt, rvec, riovcnt, flags);
}

static ssize_t gg_process_vm_writev(pid_t pid,
                                     const struct iovec *lvec, unsigned long liovcnt,
                                     const struct iovec *rvec, unsigned long riovcnt,
                                     unsigned long flags) {
    return (ssize_t)syscall(__NR_process_vm_writev, (long)pid,
                            lvec, liovcnt, rvec, riovcnt, flags);
}

#define MAX_RESULTS   500
#define MAX_REGION_MB 64
#define CHUNK_SIZE    (4 * 1024 * 1024)  /* 4MB read chunks */

/* ─── Value types ─────────────────────────────────────────────────────────── */
typedef enum { T_INT32, T_INT64, T_FLOAT, T_DOUBLE } ValType;

static ValType parse_type(const char *s) {
    if (!strcmp(s, "int64"))  return T_INT64;
    if (!strcmp(s, "float"))  return T_FLOAT;
    if (!strcmp(s, "double")) return T_DOUBLE;
    return T_INT32;
}

static int val_size(ValType t) {
    switch (t) {
        case T_INT64: case T_DOUBLE: return 8;
        default: return 4;
    }
}

/* Parse value string → bytes (little-endian) */
static int encode_value(const char *str, ValType t, uint8_t *out) {
    switch (t) {
        case T_INT32: { int32_t v = (int32_t)strtol(str, NULL, 10); memcpy(out, &v, 4); return 4; }
        case T_INT64: { int64_t v = strtoll(str, NULL, 10); memcpy(out, &v, 8); return 8; }
        case T_FLOAT: { float   v = strtof(str, NULL); memcpy(out, &v, 4); return 4; }
        case T_DOUBLE:{ double  v = strtod(str, NULL); memcpy(out, &v, 8); return 8; }
    }
    return 0;
}

/* Print bytes as value string */
static void decode_print(const uint8_t *bytes, ValType t) {
    switch (t) {
        case T_INT32: { int32_t v; memcpy(&v, bytes, 4); printf("%d", v); break; }
        case T_INT64: { int64_t v; memcpy(&v, bytes, 8); printf("%lld", (long long)v); break; }
        case T_FLOAT: { float   v; memcpy(&v, bytes, 4); printf("%g", v); break; }
        case T_DOUBLE:{ double  v; memcpy(&v, bytes, 8); printf("%g", v); break; }
    }
}

/* ─── ptrace helpers ──────────────────────────────────────────────────────── */
static int ptrace_attach(pid_t pid) {
    if (ptrace(PTRACE_ATTACH, pid, NULL, NULL) < 0) {
        fprintf(stderr, "ptrace attach failed: %s\n", strerror(errno));
        return -1;
    }
    int status;
    waitpid(pid, &status, 0);
    return 0;
}

static void ptrace_detach(pid_t pid) {
    ptrace(PTRACE_DETACH, pid, NULL, NULL);
}

/* ─── Memory read/write via syscall wrappers ──────────────────────────────── */
static ssize_t mem_read(pid_t pid, uintptr_t addr, void *buf, size_t len) {
    struct iovec local  = { buf, len };
    struct iovec remote = { (void*)addr, len };
    return gg_process_vm_readv(pid, &local, 1, &remote, 1, 0);
}

static ssize_t mem_write(pid_t pid, uintptr_t addr, const void *buf, size_t len) {
    struct iovec local  = { (void*)buf, len };
    struct iovec remote = { (void*)addr, len };
    return gg_process_vm_writev(pid, &local, 1, &remote, 1, 0);
}

/* ─── maps parser ─────────────────────────────────────────────────────────── */
typedef struct { uintptr_t start, end; } Region;

static int read_maps(pid_t pid, Region *regions, int maxr) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/maps", pid);
    FILE *f = fopen(path, "r");
    if (!f) { fprintf(stderr, "Cannot open %s: %s\n", path, strerror(errno)); return 0; }

    char line[512];
    int count = 0;
    uint64_t max_bytes = (uint64_t)MAX_REGION_MB * 1024 * 1024;

    while (fgets(line, sizeof(line), f) && count < maxr) {
        uintptr_t start, end;
        char perms[8], dev[8], pathname[256];
        unsigned long offset;
        unsigned long inode;
        pathname[0] = '\0';

        int n = sscanf(line, "%lx-%lx %7s %lx %7s %lu %255s",
                       &start, &end, perms, &offset, dev, &inode, pathname);
        if (n < 2) continue;

        /* Only rw- regions */
        if (perms[0] != 'r' || perms[1] != 'w') continue;

        /* Skip file-backed regions (libs, apk, etc.) */
        if (pathname[0] == '/' && strstr(pathname, "[heap]") == NULL) continue;

        uintptr_t size = end - start;
        if (size == 0 || size > max_bytes) continue;

        regions[count].start = start;
        regions[count].end   = end;
        count++;
    }
    fclose(f);
    return count;
}

/* ─── Boyer-Moore-Horspool search ─────────────────────────────────────────── */
typedef struct { uintptr_t addr; } Hit;

static int bmh_search(const uint8_t *hay, size_t hlen,
                      const uint8_t *needle, int nlen,
                      uintptr_t base_addr,
                      Hit *hits, int max_hits, int *nhits) {
    if (nlen == 0 || (int)hlen < nlen) return 0;

    int skip[256];
    for (int i = 0; i < 256; i++) skip[i] = nlen;
    for (int i = 0; i < nlen - 1; i++) skip[needle[i]] = nlen - 1 - i;

    size_t i = nlen - 1;
    while (i < hlen) {
        int j = nlen - 1, k = (int)i;
        while (j >= 0 && hay[k] == needle[j]) { j--; k--; }
        if (j < 0) {
            if (*nhits < max_hits) {
                hits[*nhits].addr = base_addr + (uintptr_t)(k + 1);
                (*nhits)++;
            }
        }
        i += skip[hay[i]];
    }
    return 0;
}

/* ─── SCAN command ────────────────────────────────────────────────────────── */
static int cmd_scan(pid_t pid, ValType type, const char *value_str) {
    uint8_t needle[16];
    int nlen = encode_value(value_str, type, needle);
    if (nlen == 0) { fprintf(stderr, "Invalid value\n"); return 1; }

    Region regions[4096];
    int nregions = read_maps(pid, regions, 4096);
    if (nregions == 0) { fprintf(stderr, "No readable regions\n"); return 1; }

    uint8_t *chunk = malloc(CHUNK_SIZE);
    if (!chunk) { fprintf(stderr, "OOM\n"); return 1; }

    Hit hits[MAX_RESULTS];
    int nhits = 0;

    for (int r = 0; r < nregions && nhits < MAX_RESULTS; r++) {
        uintptr_t start = regions[r].start;
        uintptr_t end   = regions[r].end;
        uintptr_t offset = 0;
        uintptr_t total = end - start;

        while (offset < total && nhits < MAX_RESULTS) {
            size_t rlen = (size_t)(total - offset);
            if (rlen > (size_t)CHUNK_SIZE) rlen = CHUNK_SIZE;

            ssize_t got = mem_read(pid, start + offset, chunk, rlen);
            if (got <= 0) { offset += rlen; continue; }

            bmh_search(chunk, (size_t)got, needle, nlen,
                       start + offset, hits, MAX_RESULTS, &nhits);
            offset += rlen;
        }
    }

    free(chunk);

    /* Output: one "ADDR VALUE" per line */
    for (int i = 0; i < nhits; i++) {
        printf("0x%lx ", (unsigned long)hits[i].addr);
        decode_print(needle, type);
        printf("\n");
    }
    printf("DONE %d\n", nhits);
    return 0;
}

/* ─── RESCAN command ──────────────────────────────────────────────────────── */
/* Reads current value at each provided address */
static int cmd_rescan(pid_t pid, ValType type, const char *addrs_csv) {
    char *buf = strdup(addrs_csv);
    char *tok = strtok(buf, ",");
    int vsize = val_size(type);
    uint8_t vbuf[16];

    while (tok) {
        uintptr_t addr = (uintptr_t)strtoull(tok, NULL, 16);
        ssize_t got = mem_read(pid, addr, vbuf, vsize);
        if (got == vsize) {
            printf("0x%lx ", (unsigned long)addr);
            decode_print(vbuf, type);
            printf("\n");
        }
        tok = strtok(NULL, ",");
    }
    free(buf);
    printf("DONE\n");
    return 0;
}

/* ─── WRITE command ───────────────────────────────────────────────────────── */
static int cmd_write(pid_t pid, ValType type, uintptr_t addr, const char *value_str) {
    uint8_t bytes[16];
    int len = encode_value(value_str, type, bytes);
    if (len == 0) { fprintf(stderr, "Invalid value\n"); return 1; }

    ssize_t w = mem_write(pid, addr, bytes, len);
    if (w != len) {
        fprintf(stderr, "Write failed at 0x%lx: %s\n", (unsigned long)addr, strerror(errno));
        return 1;
    }
    printf("OK 0x%lx\n", (unsigned long)addr);
    return 0;
}

/* ─── READ command ────────────────────────────────────────────────────────── */
static int cmd_read(pid_t pid, ValType type, uintptr_t addr) {
    uint8_t bytes[16];
    int vsize = val_size(type);
    ssize_t got = mem_read(pid, addr, bytes, vsize);
    if (got != vsize) {
        fprintf(stderr, "Read failed at 0x%lx\n", (unsigned long)addr);
        return 1;
    }
    decode_print(bytes, type);
    printf("\n");
    return 0;
}

/* ─── main ────────────────────────────────────────────────────────────────── */
int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "Usage: gg-mem <scan|rescan|write|read> <pid> ...\n");
        return 1;
    }

    const char *cmd  = argv[1];
    pid_t pid        = (pid_t)atoi(argv[2]);

    /* ptrace attach — pauses game safely like GG does */
    if (ptrace_attach(pid) < 0) return 1;

    int ret = 1;

    if (!strcmp(cmd, "scan") && argc >= 5) {
        ValType type = parse_type(argv[3]);
        ret = cmd_scan(pid, type, argv[4]);

    } else if (!strcmp(cmd, "rescan") && argc >= 5) {
        ValType type = parse_type(argv[3]);
        ret = cmd_rescan(pid, type, argv[4]);

    } else if (!strcmp(cmd, "write") && argc >= 6) {
        ValType type  = parse_type(argv[3]);
        uintptr_t addr = (uintptr_t)strtoull(argv[4], NULL, 16);
        ret = cmd_write(pid, type, addr, argv[5]);

    } else if (!strcmp(cmd, "read") && argc >= 5) {
        ValType type  = parse_type(argv[3]);
        uintptr_t addr = (uintptr_t)strtoull(argv[4], NULL, 16);
        ret = cmd_read(pid, type, addr);

    } else {
        fprintf(stderr, "Unknown command or missing args\n");
    }

    ptrace_detach(pid);
    return ret;
}
