"""
frida_runner.py — runs inside the APK via Chaquopy.
Called from Kotlin: FridaRunner.run(host, port, pid, script_path, log_path)
Writes output lines to log_path in real-time.
Returns exit code (0 = success).
"""

import frida
import sys
import os
import time
import traceback


def run(host: str, port: int, pid: int, script_path: str, log_path: str) -> int:
    def log(msg: str):
        try:
            with open(log_path, "a") as f:
                f.write(msg + "\n")
        except Exception:
            pass

    try:
        log(f"[frida_runner] connecting to {host}:{port}")
        device = frida.get_device_manager().add_remote_device(f"{host}:{port}")
        log(f"[frida_runner] connected — attaching to PID {pid}")

        session = device.attach(pid)
        log(f"[frida_runner] attached to PID {pid}")

        with open(script_path, "r") as f:
            js_code = f.read()

        script = session.create_script(js_code)

        def on_message(message, data):
            if message.get("type") == "send":
                log(f"[script] {message.get('payload', '')}")
            elif message.get("type") == "error":
                log(f"[script:error] {message.get('description', '')}")
                stack = message.get("stack", "")
                if stack:
                    log(f"[script:stack] {stack}")

        script.on("message", on_message)
        script.load()
        log("[frida_runner] script loaded — hooks active")

        # Keep alive until sentinel file is removed
        sentinel = log_path + ".run"
        open(sentinel, "w").close()
        try:
            while os.path.exists(sentinel):
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass

        log("[frida_runner] stopping — unloading script")
        try:
            script.unload()
        except Exception:
            pass
        try:
            session.detach()
        except Exception:
            pass

        log("[frida_runner] done")
        return 0

    except frida.ServerNotRunningError:
        log(f"[frida_runner:error] frida-server not running on {host}:{port}")
        return 2
    except frida.ProcessNotFoundError:
        log(f"[frida_runner:error] PID {pid} not found")
        return 3
    except frida.PermissionDeniedError:
        log(f"[frida_runner:error] permission denied — SELinux enforcing?")
        return 4
    except Exception as e:
        log(f"[frida_runner:error] {type(e).__name__}: {e}")
        log(traceback.format_exc())
        return 1
