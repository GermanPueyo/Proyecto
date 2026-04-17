import time
import requests
import psutil
import socket
import signal
import sys
import logging
import subprocess
import json
import re

# --- CONFIGURACIÓN DEL AGENTE (CAMBIAR SEGÚN NECESIDAD) ---
SERVER_URL = "http://192.168.56.1:5000" 
API_KEY = "flower-node-secret-2026"
SERVER_ID = 2 
REPORT_INTERVAL_NORMAL = 60 # Segundos entre reportes normales (1 minuto)
REPORT_INTERVAL_CRITICAL = 1 # Segundos entre reportes en crisis (Tiempo real)
# ---------------------------------------------------------

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class FlowerNodeAgent:
    def __init__(self):
        self.running = True
        self.last_report = 0
        
        # Manejo de señales para cierre limpio
        signal.signal(signal.SIGINT, self.stop)
        signal.signal(signal.SIGTERM, self.stop)

    def stop(self, signum=None, frame=None):
        logger.info("Deteniendo agente...")
        self.send_report(status="offline")
        self.running = False
        sys.exit(0)

    def get_dhcp_stats(self):
        """Detecta si el rol DHCP está instalado y obtiene estadísticas de ámbitos."""
        script = "Get-DhcpServerv4ScopeStatistics | Select-Object -First 1 | ConvertTo-Json"
        try:
            # Ejecutamos PowerShell para obtener el ámbito con más uso (o el primero)
            proc = subprocess.run(
                ["powershell", "-Command", script],
                capture_output=True, text=True, timeout=10
            )
            logger.debug(f"DHCP query: rc={proc.returncode}")
            if proc.returncode == 0 and proc.stdout.strip():
                data = json.loads(proc.stdout)
                # Mapeamos los campos de PowerShell a nuestro formato estándar
                scope_str = data.get("ScopeId", {}).get("IPAddressToString", "Global")
                return {
                    "pct": int(float(data.get("PercentageInUse", 0))),
                    "in_use": int(data.get("InUse", 0)),
                    "free": int(data.get("Free", 0)),
                    "total": int(data.get("InUse", 0) + data.get("Free", 0)),
                    "scope_id": scope_str,
                    "scope_name": scope_str
                }
        except Exception:
            pass # Si falla o no está instalado, simplemente no devolvemos nada
        return None

    def send_report(self, status="online", metrics=None):
        url = f"{SERVER_URL}/api/agent/report"
        headers = {"X-API-KEY": API_KEY, "Content-Type": "application/json"}
        payload = {"server_id": SERVER_ID, "status": status}
        if metrics: payload.update(metrics)

        try:
            response = requests.post(url, json=payload, headers=headers, timeout=5)
            return response.status_code == 200
        except Exception as e:
            logger.error(f"Error de conexion con el servidor: {e}")
            return False

    def run(self):
        logger.info(f"Agente FlowerNode operativo (Server ID: {SERVER_ID})")
        
        while self.running:
            try:
                # Captura de métricas
                metrics = {
                    "cpu": psutil.cpu_percent(interval=1),
                    "ram": psutil.virtual_memory().percent,
                    "disk": psutil.disk_usage('C:').percent
                }

                # Auto-detección de DHCP (Dinámico)
                dhcp_data = self.get_dhcp_stats()
                if dhcp_data:
                    metrics["dhcp"] = dhcp_data
                
                now = time.time()
                is_critical = any(v >= 80 for k, v in metrics.items() if isinstance(v, (int, float)))
                if dhcp_data and dhcp_data.get("pct", 0) >= 80:
                    is_critical = True
                
                # Determinamos el intervalo actual
                current_interval = REPORT_INTERVAL_CRITICAL if is_critical else REPORT_INTERVAL_NORMAL

                # Enviar si ha pasado el intervalo correspondiente
                if (now - self.last_report >= current_interval):
                    if self.send_report(metrics=metrics):
                        self.last_report = now
                        status_str = "CRÍTICO" if is_critical else "NORMAL"
                        logger.info(f"Reporte {status_str} enviado. CPU: {metrics['cpu']}% | RAM: {metrics['ram']}%")
                
                # Dormimos poco para poder reaccionar rápido si algo se vuelve crítico
                time.sleep(1)
            except Exception as e:
                logger.error(f"Error en el bucle: {e}")
                time.sleep(10)

if __name__ == "__main__":
    agent = FlowerNodeAgent()
    agent.run()
