#!/usr/bin/env bash
# Запуск приложения:
#   ./run.sh            — http://localhost:8000
#   ./run.sh --https    — https://<IP-в-сети>:8443 (нужно для камеры на телефоне)
#   ./run.sh 9000       — другой порт
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

# Если порт занят предыдущим запуском этого приложения — останавливаем его.
# Чужие программы не трогаем, только сообщаем.
free_port() {
  local port=$1 pids pid
  pids=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K\d+' | sort -u)
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "app.server:app"; then
      echo "Останавливаю предыдущий запуск (PID $pid) на порту $port…"
      kill "$pid"
      for _ in $(seq 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      kill -9 "$pid" 2>/dev/null
    else
      echo "Порт $port занят другой программой (PID $pid: $(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | cut -c1-80))."
      echo "Запустите на другом порту, например: ./run.sh $([ "$HTTPS" = 1 ] && echo '--https ')$((port + 1))"
      exit 1
    fi
  done
}

if [ "$HTTPS" = 1 ]; then
  PORT=${PORT:-8443}
  free_port "$PORT"
  mkdir -p certs
  # Самоподписанный сертификат на IP компьютера; пересоздаётся, если IP сменился
  if [ ! -f certs/cert.pem ] || ! openssl x509 -in certs/cert.pem -noout -text | grep -q "IP Address:$IP"; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=subtitles" \
      -addext "subjectAltName=IP:${IP:-127.0.0.1},IP:127.0.0.1,DNS:localhost" \
      -keyout certs/key.pem -out certs/cert.pem 2>/dev/null
  fi
  echo "Откройте на телефоне: https://${IP}:${PORT}  (браузер предупредит о сертификате — подтвердите)"
  exec .venv/bin/uvicorn app.server:app --host 0.0.0.0 --port "$PORT" \
    --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
fi

PORT=${PORT:-8000}
free_port "$PORT"
echo "На компьютере: http://localhost:${PORT}   С телефона (та же Wi-Fi сеть): http://${IP}:${PORT}"
exec .venv/bin/uvicorn app.server:app --host 0.0.0.0 --port "$PORT"
