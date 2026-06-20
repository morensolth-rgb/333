/*
 * FridaCtl — NDK Traffic Capture
 * Raw IP packets from VPN fd → TCP reassembly → HTTP parsing → JNI callbacks
 */

#include "capture.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <android/log.h>
#include <arpa/inet.h>
#include <errno.h>

#define TAG "FridaCapture"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

// ── Utility ──────────────────────────────────────────────────────────────────

static int64_t now_ms() {
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (int64_t)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

static void ip_to_str(uint32_t ip, char* buf, int len) {
    snprintf(buf, len, "%d.%d.%d.%d",
        (ip >> 24) & 0xFF, (ip >> 16) & 0xFF,
        (ip >>  8) & 0xFF,  ip        & 0xFF);
}

// ── Flow table ───────────────────────────────────────────────────────────────

static flow_t* flow_find(capture_ctx_t* ctx, flow_key_t* key) {
    for (int i = 0; i < MAX_FLOWS; i++) {
        flow_t* f = &ctx->flows[i];
        if (!f->in_use) continue;
        if (f->key.src_ip   == key->src_ip   &&
            f->key.dst_ip   == key->dst_ip   &&
            f->key.src_port == key->src_port &&
            f->key.dst_port == key->dst_port &&
            f->key.proto    == key->proto)
            return f;
        // reverse direction (server→client)
        if (f->key.src_ip   == key->dst_ip   &&
            f->key.dst_ip   == key->src_ip   &&
            f->key.src_port == key->dst_port &&
            f->key.dst_port == key->src_port &&
            f->key.proto    == key->proto)
            return f;
    }
    return NULL;
}

static flow_t* flow_create(capture_ctx_t* ctx, flow_key_t* key) {
    // find free slot — evict oldest if full
    int slot = -1;
    int64_t oldest_ts = INT64_MAX;
    int oldest_idx = 0;

    for (int i = 0; i < MAX_FLOWS; i++) {
        if (!ctx->flows[i].in_use) { slot = i; break; }
        if (ctx->flows[i].ts_ms < oldest_ts) {
            oldest_ts  = ctx->flows[i].ts_ms;
            oldest_idx = i;
        }
    }
    if (slot == -1) {
        // evict oldest
        flow_t* old = &ctx->flows[oldest_idx];
        if (old->cli_stream.data) free(old->cli_stream.data);
        if (old->srv_stream.data) free(old->srv_stream.data);
        if (old->req.body)        free(old->req.body);
        if (old->res.body)        free(old->res.body);
        memset(old, 0, sizeof(flow_t));
        slot = oldest_idx;
    }

    flow_t* f = &ctx->flows[slot];
    memset(f, 0, sizeof(flow_t));
    f->key    = *key;
    f->state  = CONN_STATE_NEW;
    f->in_use = 1;
    f->id     = ++ctx->flow_id_counter;
    f->ts_ms  = now_ms();
    return f;
}

static void flow_free(flow_t* f) {
    if (f->cli_stream.data) { free(f->cli_stream.data); f->cli_stream.data = NULL; }
    if (f->srv_stream.data) { free(f->srv_stream.data); f->srv_stream.data = NULL; }
    if (f->req.body)        { free(f->req.body);        f->req.body = NULL; }
    if (f->res.body)        { free(f->res.body);        f->res.body = NULL; }
    memset(f, 0, sizeof(flow_t));
}

// ── TCP stream buffer ─────────────────────────────────────────────────────────

static int stream_append(tcp_stream_t* s, const uint8_t* data, int len) {
    if (len <= 0) return 0;
    if (!s->data) {
        s->cap  = (len < 8192) ? 8192 : len * 2;
        s->data = (uint8_t*)malloc(s->cap);
        if (!s->data) return -1;
        s->len  = 0;
    }
    if (s->len + len > TCP_BUF_SIZE) {
        // cap at TCP_BUF_SIZE
        len = TCP_BUF_SIZE - s->len;
        if (len <= 0) return 0;
    }
    if (s->len + len > s->cap) {
        int new_cap = s->cap * 2;
        if (new_cap > TCP_BUF_SIZE) new_cap = TCP_BUF_SIZE;
        uint8_t* tmp = (uint8_t*)realloc(s->data, new_cap);
        if (!tmp) return -1;
        s->data = tmp;
        s->cap  = new_cap;
    }
    memcpy(s->data + s->len, data, len);
    s->len += len;
    return len;
}

// ── HTTP parser ───────────────────────────────────────────────────────────────

// Returns pointer to first char after \r\n\r\n, or NULL if headers incomplete
static const char* find_header_end(const char* buf, int len) {
    for (int i = 0; i < len - 3; i++) {
        if (buf[i]=='\r' && buf[i+1]=='\n' && buf[i+2]=='\r' && buf[i+3]=='\n')
            return buf + i + 4;
    }
    return NULL;
}

static void str_tolower(char* s) {
    for (; *s; s++) if (*s >= 'A' && *s <= 'Z') *s += 32;
}

// Parse "Key: Value\r\n" headers from buf[0..len]
// Returns number of headers parsed
static int parse_headers(const char* buf, int len,
                         http_header_t* hdrs, int max_hdrs,
                         int* content_length, int* chunked) {
    int count = 0;
    const char* p = buf;
    const char* end = buf + len;

    while (p < end && count < max_hdrs) {
        // find end of line
        const char* eol = p;
        while (eol < end - 1 && !(eol[0]=='\r' && eol[1]=='\n')) eol++;
        if (eol >= end - 1) break;
        int line_len = (int)(eol - p);
        if (line_len == 0) break; // blank line = end of headers

        // find colon
        const char* colon = p;
        while (colon < eol && *colon != ':') colon++;
        if (colon >= eol) { p = eol + 2; continue; }

        int name_len = (int)(colon - p);
        int val_len  = (int)(eol - colon - 1);
        const char* val_start = colon + 1;
        // trim leading space
        while (val_len > 0 && *val_start == ' ') { val_start++; val_len--; }

        if (name_len > 0 && name_len < HTTP_HEADER_NAME_LEN && val_len > 0) {
            int n = name_len < HTTP_HEADER_NAME_LEN - 1 ? name_len : HTTP_HEADER_NAME_LEN - 1;
            int v = val_len  < HTTP_HEADER_VAL_LEN  - 1 ? val_len  : HTTP_HEADER_VAL_LEN  - 1;
            memcpy(hdrs[count].name,  p,         n); hdrs[count].name[n]  = 0;
            memcpy(hdrs[count].value, val_start,  v); hdrs[count].value[v] = 0;
            str_tolower(hdrs[count].name);

            if (strcmp(hdrs[count].name, "content-length") == 0)
                *content_length = atoi(hdrs[count].value);
            if (strcmp(hdrs[count].name, "transfer-encoding") == 0 &&
                strstr(hdrs[count].value, "chunked"))
                *chunked = 1;

            count++;
        }
        p = eol + 2;
    }
    return count;
}

// Try to parse HTTP request from stream buffer
// Returns 1 if fully parsed, 0 if need more data, -1 if not HTTP
static int try_parse_request(tcp_stream_t* s, http_request_t* req) {
    if (s->len < 16) return 0;
    const char* buf = (const char*)s->data;
    int len = s->len;

    // Quick check: must start with HTTP method
    if (strncmp(buf, "GET ",    4) != 0 &&
        strncmp(buf, "POST ",   5) != 0 &&
        strncmp(buf, "PUT ",    4) != 0 &&
        strncmp(buf, "DELETE ", 7) != 0 &&
        strncmp(buf, "PATCH ",  6) != 0 &&
        strncmp(buf, "HEAD ",   5) != 0 &&
        strncmp(buf, "OPTIONS ",8) != 0 &&
        strncmp(buf, "CONNECT ",8) != 0)
        return -1;

    const char* body_start = find_header_end(buf, len);
    if (!body_start) return 0; // headers not complete yet

    // Parse request line
    const char* eol = buf;
    while (eol < buf + len && *eol != '\r' && *eol != '\n') eol++;
    char reqline[2048];
    int rl_len = (int)(eol - buf);
    if (rl_len <= 0 || rl_len >= (int)sizeof(reqline)) return -1;
    memcpy(reqline, buf, rl_len);
    reqline[rl_len] = 0;

    // method
    char* sp1 = strchr(reqline, ' ');
    if (!sp1) return -1;
    *sp1 = 0;
    strncpy(req->method, reqline, sizeof(req->method)-1);

    // url
    char* sp2 = strchr(sp1+1, ' ');
    if (!sp2) return -1;
    *sp2 = 0;
    strncpy(req->url, sp1+1, sizeof(req->url)-1);

    // version
    strncpy(req->version, sp2+1, sizeof(req->version)-1);

    // path (url without scheme://host)
    const char* path_start = req->url;
    if (strncmp(path_start, "http://",  7) == 0) path_start += 7;
    if (strncmp(path_start, "https://", 8) == 0) path_start += 8;
    const char* slash = strchr(path_start, '/');
    if (slash) strncpy(req->path, slash, sizeof(req->path)-1);
    else       strncpy(req->path, "/",   sizeof(req->path)-1);

    // headers
    int hdr_section_len = (int)(body_start - (buf + rl_len + 2));
    req->content_length = -1;
    req->chunked = 0;
    req->header_count = parse_headers(buf + rl_len + 2, hdr_section_len,
                                      req->headers, HTTP_MAX_HEADERS,
                                      &req->content_length, &req->chunked);

    // extract host from headers
    for (int i = 0; i < req->header_count; i++) {
        if (strcmp(req->headers[i].name, "host") == 0) {
            strncpy(req->host, req->headers[i].value, sizeof(req->host)-1);
            break;
        }
    }

    // body
    int header_bytes = (int)(body_start - buf);
    int remaining    = len - header_bytes;

    if (req->content_length > 0) {
        if (remaining < req->content_length) return 0; // wait for more
        int blen = req->content_length < HTTP_MAX_BODY ? req->content_length : HTTP_MAX_BODY;
        req->body = (char*)malloc(blen + 1);
        if (req->body) {
            memcpy(req->body, body_start, blen);
            req->body[blen] = 0;
            req->body_len   = blen;
        }
    } else if (req->chunked) {
        // best effort: grab what we have
        int blen = remaining < HTTP_MAX_BODY ? remaining : HTTP_MAX_BODY;
        if (blen > 0) {
            req->body = (char*)malloc(blen + 1);
            if (req->body) {
                memcpy(req->body, body_start, blen);
                req->body[blen] = 0;
                req->body_len   = blen;
            }
        }
    }

    return 1;
}

// Try to parse HTTP response from stream buffer
static int try_parse_response(tcp_stream_t* s, http_response_t* res) {
    if (s->len < 12) return 0;
    const char* buf = (const char*)s->data;
    int len = s->len;

    if (strncmp(buf, "HTTP/", 5) != 0) return -1;

    const char* body_start = find_header_end(buf, len);
    if (!body_start) return 0;

    // Status line
    const char* eol = buf;
    while (eol < buf + len && *eol != '\r' && *eol != '\n') eol++;
    char statusline[256];
    int sl_len = (int)(eol - buf);
    if (sl_len <= 0 || sl_len >= (int)sizeof(statusline)) return -1;
    memcpy(statusline, buf, sl_len);
    statusline[sl_len] = 0;

    // HTTP/1.x CODE TEXT
    char* sp1 = strchr(statusline, ' ');
    if (!sp1) return -1;
    *sp1 = 0;
    strncpy(res->version, statusline, sizeof(res->version)-1);

    char* sp2 = strchr(sp1+1, ' ');
    if (sp2) {
        *sp2 = 0;
        res->status_code = atoi(sp1+1);
        strncpy(res->status_text, sp2+1, sizeof(res->status_text)-1);
    } else {
        res->status_code = atoi(sp1+1);
    }

    // headers
    int hdr_section_len = (int)(body_start - (buf + sl_len + 2));
    res->content_length = -1;
    res->chunked = 0;
    res->header_count = parse_headers(buf + sl_len + 2, hdr_section_len,
                                      res->headers, HTTP_MAX_HEADERS,
                                      &res->content_length, &res->chunked);

    // body
    int header_bytes = (int)(body_start - buf);
    int remaining    = len - header_bytes;

    if (res->content_length > 0) {
        if (remaining < res->content_length) return 0;
        int blen = res->content_length < HTTP_MAX_BODY ? res->content_length : HTTP_MAX_BODY;
        res->body = (char*)malloc(blen + 1);
        if (res->body) {
            memcpy(res->body, body_start, blen);
            res->body[blen] = 0;
            res->body_len   = blen;
        }
    } else if (res->chunked) {
        int blen = remaining < HTTP_MAX_BODY ? remaining : HTTP_MAX_BODY;
        if (blen > 0) {
            res->body = (char*)malloc(blen + 1);
            if (res->body) {
                memcpy(res->body, body_start, blen);
                res->body[blen] = 0;
                res->body_len   = blen;
            }
        }
    } else if (remaining > 0) {
        // no content-length, no chunked — grab what we have
        int blen = remaining < HTTP_MAX_BODY ? remaining : HTTP_MAX_BODY;
        res->body = (char*)malloc(blen + 1);
        if (res->body) {
            memcpy(res->body, body_start, blen);
            res->body[blen] = 0;
            res->body_len   = blen;
        }
    }

    return 1;
}

// ── JNI callbacks ─────────────────────────────────────────────────────────────

static JNIEnv* get_env(capture_ctx_t* ctx) {
    JNIEnv* env = NULL;
    if ((*ctx->jvm)->GetEnv(ctx->jvm, (void**)&env, JNI_VERSION_1_6) == JNI_EDETACHED) {
        if ((*ctx->jvm)->AttachCurrentThread(ctx->jvm, &env, NULL) != 0)
            return NULL;
    }
    return env;
}

// Build JSON string of headers
static jstring headers_to_jstring(JNIEnv* env, http_header_t* hdrs, int count) {
    char buf[8192];
    int pos = 0;
    pos += snprintf(buf + pos, sizeof(buf) - pos, "{");
    for (int i = 0; i < count && pos < (int)sizeof(buf) - 128; i++) {
        if (i > 0) pos += snprintf(buf + pos, sizeof(buf) - pos, ",");
        pos += snprintf(buf + pos, sizeof(buf) - pos, "\"%s\":\"%s\"",
                        hdrs[i].name, hdrs[i].value);
    }
    pos += snprintf(buf + pos, sizeof(buf) - pos, "}");
    return (*env)->NewStringUTF(env, buf);
}

static void cb_on_packet(capture_ctx_t* ctx, flow_key_t* key, int len) {
    JNIEnv* env = get_env(ctx);
    if (!env || !ctx->mid_on_packet) return;

    char src_buf[20], dst_buf[20];
    ip_to_str(key->src_ip, src_buf, sizeof(src_buf));
    ip_to_str(key->dst_ip, dst_buf, sizeof(dst_buf));

    jstring jsrc   = (*env)->NewStringUTF(env, src_buf);
    jstring jdst   = (*env)->NewStringUTF(env, dst_buf);
    jstring jproto = (*env)->NewStringUTF(env, key->proto == 6 ? "TCP" : "UDP");

    (*env)->CallVoidMethod(env, ctx->module_obj, ctx->mid_on_packet,
                           (jlong)now_ms(), jsrc, jdst,
                           (jint)key->dst_port, (jint)len, jproto);

    (*env)->DeleteLocalRef(env, jsrc);
    (*env)->DeleteLocalRef(env, jdst);
    (*env)->DeleteLocalRef(env, jproto);
    (*env)->ExceptionClear(env);
}

static void cb_on_http_request(capture_ctx_t* ctx, flow_t* f) {
    JNIEnv* env = get_env(ctx);
    if (!env || !ctx->mid_on_http_req) return;

    http_request_t* req = &f->req;

    jlong   jid      = (jlong)f->id;
    jlong   jts      = (jlong)f->ts_ms;
    jstring jmethod  = (*env)->NewStringUTF(env, req->method);
    jstring jurl     = (*env)->NewStringUTF(env, req->url);
    jstring jhost    = (*env)->NewStringUTF(env, req->host);
    jstring jpath    = (*env)->NewStringUTF(env, req->path);
    jstring jhdrs    = headers_to_jstring(env, req->headers, req->header_count);
    jstring jbody    = (*env)->NewStringUTF(env, req->body ? req->body : "");

    (*env)->CallVoidMethod(env, ctx->module_obj, ctx->mid_on_http_req,
                           jid, jts, jmethod, jurl, jhost, jpath, jhdrs, jbody);

    (*env)->DeleteLocalRef(env, jmethod);
    (*env)->DeleteLocalRef(env, jurl);
    (*env)->DeleteLocalRef(env, jhost);
    (*env)->DeleteLocalRef(env, jpath);
    (*env)->DeleteLocalRef(env, jhdrs);
    (*env)->DeleteLocalRef(env, jbody);
    (*env)->ExceptionClear(env);
}

static void cb_on_http_response(capture_ctx_t* ctx, flow_t* f) {
    JNIEnv* env = get_env(ctx);
    if (!env || !ctx->mid_on_http_res) return;

    http_response_t* res = &f->res;

    jlong   jreqid   = (jlong)f->id;
    jlong   jts      = (jlong)now_ms();
    jint    jcode    = (jint)res->status_code;
    jstring jstatus  = (*env)->NewStringUTF(env, res->status_text);
    jstring jhdrs    = headers_to_jstring(env, res->headers, res->header_count);
    jstring jbody    = (*env)->NewStringUTF(env, res->body ? res->body : "");

    (*env)->CallVoidMethod(env, ctx->module_obj, ctx->mid_on_http_res,
                           jreqid, jts, jcode, jstatus, jhdrs, jbody);

    (*env)->DeleteLocalRef(env, jstatus);
    (*env)->DeleteLocalRef(env, jhdrs);
    (*env)->DeleteLocalRef(env, jbody);
    (*env)->ExceptionClear(env);
}

// ── IP packet parser ──────────────────────────────────────────────────────────

static void handle_tcp(capture_ctx_t* ctx, flow_key_t* key,
                        const uint8_t* pkt, int pkt_len,
                        int ip_hdr_len) {
    if (pkt_len < ip_hdr_len + 20) return;

    const uint8_t* tcp = pkt + ip_hdr_len;
    int tcp_hdr_len = ((tcp[12] >> 4) & 0xF) * 4;
    if (tcp_hdr_len < 20 || pkt_len < ip_hdr_len + tcp_hdr_len) return;

    uint8_t flags   = tcp[13];
    uint32_t seq    = ((uint32_t)tcp[4]<<24)|((uint32_t)tcp[5]<<16)|
                      ((uint32_t)tcp[6]<<8) | tcp[7];

    int payload_off = ip_hdr_len + tcp_hdr_len;
    int payload_len = pkt_len - payload_off;

    // SYN — new connection
    if ((flags & 0x02) && !(flags & 0x10)) {
        flow_t* f = flow_find(ctx, key);
        if (!f) {
            f = flow_create(ctx, key);
            f->cli_stream.next_seq = seq + 1;
            f->state = CONN_STATE_NEW;
        }
        return;
    }

    // RST or FIN — close connection
    if (flags & 0x04 || flags & 0x01) {
        flow_t* f = flow_find(ctx, key);
        if (f) {
            // try to parse anything buffered before closing
            if (!f->req_parsed && f->cli_stream.len > 0) {
                int r = try_parse_request(&f->cli_stream, &f->req);
                if (r == 1) { f->req_parsed = 1; cb_on_http_request(ctx, f); }
            }
            if (!f->res_parsed && f->srv_stream.len > 0) {
                int r = try_parse_response(&f->srv_stream, &f->res);
                if (r == 1) { f->res_parsed = 1; cb_on_http_response(ctx, f); }
            }
            flow_free(f);
        }
        return;
    }

    if (payload_len <= 0) return;

    const uint8_t* payload = pkt + payload_off;

    flow_t* f = flow_find(ctx, key);
    if (!f) {
        // ACK without SYN — mid-session, create anyway
        f = flow_create(ctx, key);
    }
    f->ts_ms = now_ms();

    // Determine direction: if src matches flow key src → client→server, else server→client
    int is_client = (key->src_ip == f->key.src_ip && key->src_port == f->key.src_port);

    tcp_stream_t* stream = is_client ? &f->cli_stream : &f->srv_stream;
    stream_append(stream, payload, payload_len);

    // Try HTTP parse
    if (is_client && !f->req_parsed) {
        int r = try_parse_request(&f->cli_stream, &f->req);
        if (r == 1) {
            f->req_parsed = 1;
            cb_on_http_request(ctx, f);
        } else if (r == -1) {
            f->req_parsed = -1; // not HTTP, skip
        }
    }
    if (!is_client && !f->res_parsed && f->req_parsed == 1) {
        int r = try_parse_response(&f->srv_stream, &f->res);
        if (r == 1) {
            f->res_parsed = 1;
            cb_on_http_response(ctx, f);
        }
    }
}

static void handle_packet(capture_ctx_t* ctx, const uint8_t* pkt, int len) {
    if (len < 20) return;

    uint8_t version = (pkt[0] >> 4) & 0xF;
    if (version != 4) return; // IPv4 only

    int ip_hdr_len = (pkt[0] & 0xF) * 4;
    if (ip_hdr_len < 20 || len < ip_hdr_len) return;

    uint8_t proto = pkt[9];
    if (proto != 6 && proto != 17) return; // TCP and UDP only

    uint32_t src_ip = ((uint32_t)pkt[12]<<24)|((uint32_t)pkt[13]<<16)|
                      ((uint32_t)pkt[14]<<8)  | pkt[15];
    uint32_t dst_ip = ((uint32_t)pkt[16]<<24)|((uint32_t)pkt[17]<<16)|
                      ((uint32_t)pkt[18]<<8)  | pkt[19];

    if (len < ip_hdr_len + 4) return;
    uint16_t src_port = ((uint16_t)pkt[ip_hdr_len]   << 8) | pkt[ip_hdr_len+1];
    uint16_t dst_port = ((uint16_t)pkt[ip_hdr_len+2] << 8) | pkt[ip_hdr_len+3];

    flow_key_t key = {
        .src_ip   = src_ip,
        .dst_ip   = dst_ip,
        .src_port = src_port,
        .dst_port = dst_port,
        .proto    = proto
    };

    ctx->total_packets++;
    ctx->total_bytes += len;

    // Emit raw packet event
    cb_on_packet(ctx, &key, len);

    // TCP reassembly + HTTP parse
    if (proto == 6) {
        handle_tcp(ctx, &key, pkt, len, ip_hdr_len);
    }
}

// ── Main capture loop ─────────────────────────────────────────────────────────

void capture_run(capture_ctx_t* ctx) {
    uint8_t buf[65535];
    LOGI("capture_run started, fd=%d", ctx->vpn_fd);

    ctx->running = 1;
    while (ctx->running) {
        int n = read(ctx->vpn_fd, buf, sizeof(buf));
        if (n < 0) {
            if (errno == EINTR) continue;
            LOGW("read error: %s", strerror(errno));
            break;
        }
        if (n == 0) break;
        handle_packet(ctx, buf, n);
    }

    LOGI("capture_run stopped");
    ctx->running = 0;
}

void capture_stop(capture_ctx_t* ctx) {
    ctx->running = 0;
}

// ── JNI entry points ──────────────────────────────────────────────────────────

static capture_ctx_t* g_ctx = NULL;

JNIEXPORT jlong JNICALL
Java_com_fridactl_TrafficModule_nativeCreate(JNIEnv* env, jobject thiz, jint fd) {
    capture_ctx_t* ctx = (capture_ctx_t*)calloc(1, sizeof(capture_ctx_t));
    if (!ctx) return 0;

    ctx->vpn_fd = fd;
    (*env)->GetJavaVM(env, &ctx->jvm);
    ctx->module_obj = (*env)->NewGlobalRef(env, thiz);

    jclass clazz = (*env)->GetObjectClass(env, thiz);

    ctx->mid_on_packet = (*env)->GetMethodID(env, clazz,
        "onNativePacket", "(JLjava/lang/String;Ljava/lang/String;IILjava/lang/String;)V");
    ctx->mid_on_http_req = (*env)->GetMethodID(env, clazz,
        "onNativeHttpRequest", "(JJLjava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V");
    ctx->mid_on_http_res = (*env)->GetMethodID(env, clazz,
        "onNativeHttpResponse", "(JJILjava/lang/String;Ljava/lang/String;Ljava/lang/String;)V");

    if (!ctx->mid_on_packet || !ctx->mid_on_http_req || !ctx->mid_on_http_res) {
        LOGE("Failed to find JNI method IDs");
        (*env)->DeleteGlobalRef(env, ctx->module_obj);
        free(ctx);
        return 0;
    }

    g_ctx = ctx;
    LOGI("nativeCreate OK, fd=%d", fd);
    return (jlong)(uintptr_t)ctx;
}

JNIEXPORT void JNICALL
Java_com_fridactl_TrafficModule_nativeRun(JNIEnv* env, jobject thiz, jlong ptr) {
    capture_ctx_t* ctx = (capture_ctx_t*)(uintptr_t)ptr;
    if (!ctx) return;
    capture_run(ctx);
}

JNIEXPORT void JNICALL
Java_com_fridactl_TrafficModule_nativeStop(JNIEnv* env, jobject thiz, jlong ptr) {
    capture_ctx_t* ctx = (capture_ctx_t*)(uintptr_t)ptr;
    if (!ctx) return;
    capture_stop(ctx);
}

JNIEXPORT void JNICALL
Java_com_fridactl_TrafficModule_nativeDestroy(JNIEnv* env, jobject thiz, jlong ptr) {
    capture_ctx_t* ctx = (capture_ctx_t*)(uintptr_t)ptr;
    if (!ctx) return;

    ctx->running = 0;
    if (ctx->module_obj) (*env)->DeleteGlobalRef(env, ctx->module_obj);

    // free all flows
    for (int i = 0; i < MAX_FLOWS; i++) {
        if (ctx->flows[i].in_use) flow_free(&ctx->flows[i]);
    }
    free(ctx);
    g_ctx = NULL;
}
