import time
import requests
import psutil
import socket
import signal
import sys
import logging

# --- CONFIGURACIÓN DEL AGENTE ---
SERVER_URL = "http://192.168.56.1:5000" # Cambia esto por la IP del servidor central
API_KEY = "flower-node-secret-2026"
SERVER_ID = 2 # IMPORTANTE: Debe coincidir con el ID del servidor en la base de datos central
# --------------------------------

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class FlowerNodeAgent:
    def __init__(self):
        self.running = True
        self.last_heartbeat = 0
        self.report_interval = 30 # Segundos entre reportes de métricas (Pruebas: 30s)
        self.heartbeat_interval = 60 # Segundos entre latidos (estoy vivo)
        
        # Registrar señales de apagado (Last Gasp)
        signal.signal(signal.SIGINT, self.handle_shutdown)
        signal.signal(signal.SIGTERM, self.handle_shutdown)

    def get_metrics(self):
        """Captura métricas locales usando psutil."""
        try:
            return {
                "cpu": psutil.cpu_percent(interval=1),
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
        
        # --- 1. STARTUP SYNC: Informe inicial inmediato para visibilidad ---
        logger.info("Enviando reporte de inicio...")
        m_start = {
            "cpu": psutil.cpu_percent(interval=0.5),
            "ram": psutil.virtual_memory().percent,
            "disk": psutil.disk_usage('C:').percent
        }
        self.send_report(status="online", metrics=m_start)
        self.last_heartbeat = time.time()

        while self.running:
            # --- 2. LOCAL MONITORING: Pulso rápido de 1s ---
            time.sleep(1) 
            now = time.time()
            
            # Captura rápida
            metrics = {
                "cpu": psutil.cpu_percent(interval=0.1),
                "ram": psutil.virtual_memory().percent,
                "disk": psutil.disk_usage('C:').percent
            }
            
            # ¿Hay crisis?
            is_critical = any(v >= 80 for v in metrics.values())
            
            # --- 3. DECISIÓN DE ENVÍO ---
            # Caso A: CRISIS -> Enviar de inmediato si es la primera vez o ha pasado 1s
            if is_critical:
                success = self.send_report(status="online", metrics=metrics)
                if success:
                    self.last_heartbeat = now
                    logger.info(f"[🔥 ALERTA CRÍTICA] CPU: {metrics['cpu']}% | RAM: {metrics['ram']}%")
            
            # Caso B: NORMAL -> Esperar al intervalo (10s en pruebas, luego 900s)
            elif (now - self.last_heartbeat >= self.report_interval):
                success = self.send_report(status="online", metrics=metrics)
                if success:
                    self.last_heartbeat = now
                    logger.info(f"[✅ NORMAL] Reporte periódico enviado. CPU: {metrics['cpu']}%")

if __name__ == "__main__":
    # Asegúrate de instalar dependencias primero:
    # pip install psutil requests
    agent = FlowerNodeAgent()
    agent.run()
