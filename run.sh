#!/usr/bin/env bash
# Start the app:
#   ./run.sh            — http://localhost:8000
#   ./run.sh --https    — https://<LAN-IP>:8443 (required for the camera on a phone)
#   ./run.sh 9000       — custom port
cd "$(dirname "$0")"

HTTPS=0
PORT=""
for arg in "$@"; do
  case "$arg" in
    --https) HTTPS=1 ;;
    *) PORT="$arg" ;;
  esac
done

IP=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[\d.]+')

# If the port is held by a previous run of this app, stop it.
# Other programs are left alone; we only report them.
free_port() {
  local port=$1 pids pid
  pids=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K\d+' | sort -u)
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "app.server:app"; then
      echo "Stopping previous run (PID $pid) on port $port…"
      kill "$pid"
      for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      kill -9 "$pid" 2>/dev/null
    else
      echo "Port $port is used by another program (PID $pid: $(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | cut -c1-80))."
      echo "Run on another port, e.g.: ./run.sh $([ "$HTTPS" = 1 ] && echo '--https ')$((port + 1))"
      exit 1
    fi
  done
}

if [ "$HTTPS" = 1 ]; then
  PORT=${PORT:-8443}
  free_port "$PORT"
  mkdir -p certs
  # Self-signed certificate for this machine's IP; regenerated if the IP changes
  if [ ! -f certs/cert.pem ] || ! openssl x509 -in certs/cert.pem -noout -text | grep -q "IP Address:$IP"; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=subtitles" \
      -addext "subjectAltName=IP:${IP:-127.0.0.1},IP:127.0.0.1,DNS:localhost" \
      -keyout certs/key.pem -out certs/cert.pem 2>/dev/null
  fi
  echo "Open on your phone: https://${IP}:${PORT}  (the browser will warn about the certificate — accept it)"
  exec .venv/bin/uvicorn app.server:app --host 0.0.0.0 --port "$PORT" \
    --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
fi

PORT=${PORT:-8000}
free_port "$PORT"
echo "On this computer: http://localhost:${PORT}   From a phone (same Wi-Fi): http://${IP}:${PORT}"
exec .venv/bin/uvicorn app.server:app --host 0.0.0.0 --port "$PORT"
