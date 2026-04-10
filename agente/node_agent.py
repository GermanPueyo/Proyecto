import time
import requests
import psutil
import socket
import signal
import sys
import logging

# --- CONFIGURACIÓN DEL AGENTE ---
SERVER_URL = "http://localhost:5000" # Cambia esto por la IP del servidor central
API_KEY = "flower-node-secret-2026"
SERVER_ID = 1 # IMPORTANTE: Debe coincidir con el ID del servidor en la base de datos central
# --------------------------------

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class FlowerNodeAgent:
    def __init__(self):
        self.running = True
        self.last_heartbeat = 0
        self.report_interval = 10 # Segundos entre reportes de métricas
        self.heartbeat_interval = 60 # Segundos entre latidos (estoy vivo)
        
        # Registrar señales de apagado (Last Gasp)
        signal.signal(signal.SIGINT, self.handle_shutdown)
        signal.signal(signal.SIGTERM, self.handle_shutdown)

    def get_metrics(self):
        """Captura métricas locales usando psutil."""
        try:
            return {
                "cpu": psutil.cpu_percentage(interval=1),
                "ram": psutil.virtual_memory().percent,
                "disk": psutil.disk_usage('C:').percent
            }
        except Exception as e:
            logger.error(f"Error capturando métricas: {e}")
            return None

    def send_report(self, status="online", metrics=None):
        """Envía el paquete JSON al servidor central."""
        url = f"{SERVER_URL}/api/agent/report"
        headers = {
            "X-API-KEY": API_KEY,
            "Content-Type": "application/json"
        }
        
        payload = {
            "server_id": SERVER_ID,
            "status": status
        }
        if metrics:
            payload.update(metrics)

        try:
            response = requests.post(url, json=payload, headers=headers, timeout=5)
            if response.status_code == 200:
                return True
            else:
                logger.warning(f"Error del servidor ({response.status_code}): {response.text}")
        except Exception as e:
            logger.error(f"Error de conexión con el servidor: {e}")
        return False

    def handle_shutdown(self, signum, frame):
        """Función 'Last Gasp': Notifica el apagado antes de morir."""
        logger.info(f"Señal de apagado detectada ({signum}). Enviando Last Gasp...")
        self.send_report(status="shutting_down")
        self.running = False
        sys.exit(0)

    def run(self):
        logger.info(f"Agente Flower Node iniciado para Server ID: {SERVER_ID}")
        
        while self.running:
            now = time.time()
            metrics = self.get_metrics()
            
            if metrics:
                # Comprobar si hay niveles críticos (>80%) para envío inmediato
                is_critical = any(v >= 80 for v in metrics.values())
                
                # Si es crítico o si ha pasado el intervalo normal, enviamos
                if is_critical or (now - self.last_heartbeat >= self.report_interval):
                    success = self.send_report(status="online", metrics=metrics)
                    if success:
                        self.last_heartbeat = now
                        logger.info(f"Reporte enviado: CPU {metrics['cpu']}% | RAM {metrics['ram']}% | DISK {metrics['disk']}%")
            
            time.sleep(self.report_interval)

if __name__ == "__main__":
    # Asegúrate de instalar dependencias primero:
    # pip install psutil requests
    agent = FlowerNodeAgent()
    agent.run()
