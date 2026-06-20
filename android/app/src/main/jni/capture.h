#pragma once
#include <stdint.h>
#include <jni.h>

// ── Connection states ────────────────────────────────────────────────────────
#define CONN_STATE_NEW       0
#define CONN_STATE_OPEN      1
#define CONN_STATE_CLOSED    2

// ── Max tracked flows ────────────────────────────────────────────────────────
#define MAX_FLOWS            4096
#define TCP_BUF_SIZE         (128 * 1024)   // 128KB per direction
#define HTTP_MAX_HEADERS     32
#define HTTP_HEADER_NAME_LEN 64
#define HTTP_HEADER_VAL_LEN  512
#define HTTP_MAX_BODY        (64 * 1024)    // 64KB body cap

// ── 5-tuple flow key ─────────────────────────────────────────────────────────
typedef struct {
    uint32_t src_ip;
    uint32_t dst_ip;
    uint16_t src_port;
    uint16_t dst_port;
    uint8_t  proto;      // 6=TCP, 17=UDP
} flow_key_t;

// ── HTTP header ──────────────────────────────────────────────────────────────
typedef struct {
    char name[HTTP_HEADER_NAME_LEN];
    char value[HTTP_HEADER_VAL_LEN];
} http_header_t;

// ── Parsed HTTP request ──────────────────────────────────────────────────────
typedef struct {
    char           method[16];
    char           url[2048];
    char           host[256];
    char           path[1024];
    char           version[16];
    http_header_t  headers[HTTP_MAX_HEADERS];
    int            header_count;
    char*          body;
    int            body_len;
    int            content_length;
    int            chunked;
} http_request_t;

// ── Parsed HTTP response ─────────────────────────────────────────────────────
typedef struct {
    int            status_code;
    char           status_text[128];
    char           version[16];
    http_header_t  headers[HTTP_MAX_HEADERS];
    int            header_count;
    char*          body;
    int            body_len;
    int            content_length;
    int            chunked;
} http_response_t;

// ── TCP stream buffer (one direction) ───────────────────────────────────────
typedef struct {
    uint8_t* data;
    int      len;
    int      cap;
    uint32_t next_seq;
    int      initialized;
} tcp_stream_t;

// ── Flow entry ───────────────────────────────────────────────────────────────
typedef struct {
    flow_key_t    key;
    int           state;
    int64_t       id;
    int64_t       ts_ms;

    // TCP reassembly buffers (client→server, server→client)
    tcp_stream_t  cli_stream;   // client → server (requests)
    tcp_stream_t  srv_stream;   // server → client (responses)

    // HTTP parse state
    int           req_parsed;
    int           res_parsed;
    http_request_t  req;
    http_response_t res;

    int           in_use;
} flow_t;

// ── Capture context ──────────────────────────────────────────────────────────
typedef struct {
    int       vpn_fd;
    int       running;
    JavaVM*   jvm;
    jobject   module_obj;   // TrafficModule instance (GlobalRef)

    // Cached method IDs
    jmethodID mid_on_packet;
    jmethodID mid_on_http_req;
    jmethodID mid_on_http_res;

    flow_t    flows[MAX_FLOWS];
    int64_t   flow_id_counter;
    int64_t   total_bytes;
    int64_t   total_packets;
} capture_ctx_t;

// ── Public API ───────────────────────────────────────────────────────────────
void capture_run(capture_ctx_t* ctx);
void capture_stop(capture_ctx_t* ctx);
