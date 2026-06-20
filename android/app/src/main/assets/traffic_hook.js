// FridaCtl — HTTP/HTTPS traffic hook
// Hooks: OkHttp3/4, HttpURLConnection, Retrofit (via OkHttp)
// Sends captured requests/responses to native via send()

(function () {
  'use strict';

  function safeStr(v) {
    try { return v ? String(v) : ''; } catch (_) { return ''; }
  }

  function headersToObj(headers) {
    var obj = {};
    try {
      var names = headers.names();
      var iter = names.iterator();
      while (iter.hasNext()) {
        var name = iter.next();
        obj[safeStr(name).toLowerCase()] = safeStr(headers.get(name));
      }
    } catch (_) {}
    return obj;
  }

  function sendEvent(type, data) {
    try {
      send(JSON.stringify({ type: type, data: data }));
    } catch (_) {}
  }

  // ── OkHttp3 / OkHttp4 ──────────────────────────────────────────────────────
  function hookOkHttp() {
    var classNames = [
      'okhttp3.OkHttpClient',
      'okhttp3.internal.connection.RealCall',
      'okhttp3.RealCall'
    ];

    // Hook RealCall.execute()
    var RealCall = null;
    var candidates = [
      'okhttp3.RealCall',
      'okhttp3.internal.connection.RealCall'
    ];
    for (var i = 0; i < candidates.length; i++) {
      try {
        RealCall = Java.use(candidates[i]);
        break;
      } catch (_) {}
    }

    if (!RealCall) {
      // Try via class loader search
      try {
        Java.enumerateLoadedClasses({
          onMatch: function(name) {
            if (name.indexOf('okhttp3') !== -1 && name.indexOf('RealCall') !== -1) {
              try { RealCall = Java.use(name); } catch (_) {}
            }
          },
          onComplete: function() {}
        });
      } catch (_) {}
    }

    if (!RealCall) return false;

    try {
      RealCall.execute.implementation = function () {
        var response = this.execute();
        try {
          var request = this.request();
          var reqId   = Date.now();

          // Request
          var reqBody   = '';
          var reqBodyObj = request.body();
          if (reqBodyObj) {
            try {
              var Buffer = Java.use('okio.Buffer');
              var buf = Buffer.$new();
              reqBodyObj.writeTo(buf);
              reqBody = buf.readUtf8();
            } catch (_) {}
          }

          var reqHeaders = {};
          try { reqHeaders = headersToObj(request.headers()); } catch (_) {}

          sendEvent('request', {
            id:      reqId,
            ts:      Date.now(),
            method:  safeStr(request.method()),
            url:     safeStr(request.url().toString()),
            host:    safeStr(request.url().host()),
            path:    safeStr(request.url().encodedPath()),
            headers: reqHeaders,
            body:    reqBody,
            source:  'frida'
          });

          // Response
          var resCode = response.code();
          var resMsg  = safeStr(response.message());
          var resHeaders = {};
          try { resHeaders = headersToObj(response.headers()); } catch (_) {}

          var resBody = '';
          try {
            var peekBody = response.peekBody(131072); // 128KB max
            resBody = safeStr(peekBody.string());
          } catch (_) {}

          sendEvent('response', {
            requestId:  reqId,
            ts:         Date.now(),
            statusCode: resCode,
            statusText: resMsg,
            headers:    resHeaders,
            body:       resBody,
            source:     'frida'
          });

        } catch (e) {
          // Never crash the app
        }
        return response;
      };
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── HttpURLConnection ──────────────────────────────────────────────────────
  function hookHttpURLConnection() {
    try {
      var HttpURLConnection = Java.use('java.net.HttpURLConnection');
      var URL = Java.use('java.net.URL');

      // Hook getInputStream (response available after this)
      HttpURLConnection.getInputStream.implementation = function () {
        var stream = this.getInputStream();
        try {
          var reqId   = Date.now();
          var url     = safeStr(this.getURL().toString());
          var method  = safeStr(this.getRequestMethod());
          var resCode = this.getResponseCode();
          var resMsg  = safeStr(this.getResponseMessage());

          // Request headers
          var reqHeaders = {};
          try {
            var props = this.getRequestProperties();
            var keys  = props.keySet().toArray();
            for (var i = 0; i < keys.length; i++) {
              var k = safeStr(keys[i]);
              reqHeaders[k.toLowerCase()] = safeStr(props.get(keys[i]).toString());
            }
          } catch (_) {}

          sendEvent('request', {
            id:      reqId,
            ts:      Date.now(),
            method:  method,
            url:     url,
            host:    safeStr(this.getURL().getHost()),
            path:    safeStr(this.getURL().getPath()),
            headers: reqHeaders,
            body:    '',
            source:  'frida'
          });

          // Read response body (clone stream)
          var InputStreamReader = Java.use('java.io.InputStreamReader');
          var BufferedReader    = Java.use('java.io.BufferedReader');
          var StringBuilder     = Java.use('java.lang.StringBuilder');

          var resBody = '';
          try {
            var reader = BufferedReader.$new(InputStreamReader.$new(stream));
            var sb     = StringBuilder.$new();
            var line;
            var count = 0;
            while ((line = reader.readLine()) !== null && count < 2000) {
              sb.append(line).append('\n');
              count++;
            }
            resBody = safeStr(sb.toString());
            // Wrap original stream back
            var ByteArrayInputStream = Java.use('java.io.ByteArrayInputStream');
            stream = ByteArrayInputStream.$new(sb.toString().getBytes('UTF-8'));
          } catch (_) {}

          // Response headers
          var resHeaders = {};
          try {
            var fields = this.getHeaderFields();
            var hKeys  = fields.keySet().toArray();
            for (var j = 0; j < hKeys.length; j++) {
              if (hKeys[j] !== null) {
                resHeaders[safeStr(hKeys[j]).toLowerCase()] = safeStr(fields.get(hKeys[j]).toString());
              }
            }
          } catch (_) {}

          sendEvent('response', {
            requestId:  reqId,
            ts:         Date.now(),
            statusCode: resCode,
            statusText: resMsg,
            headers:    resHeaders,
            body:       resBody,
            source:     'frida'
          });

        } catch (_) {}
        return stream;
      };
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── Main ───────────────────────────────────────────────────────────────────
  Java.perform(function () {
    var okHttpHooked = hookOkHttp();
    var httpUrlHooked = hookHttpURLConnection();

    send(JSON.stringify({
      type: 'hook_status',
      data: {
        okhttp:     okHttpHooked,
        httpurl:    httpUrlHooked,
        ts:         Date.now()
      }
    }));
  });

})();
