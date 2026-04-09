import logging

class PollingFilter(logging.Filter):
    """
    Filtro personalizado para el logger de Werkzeug. 
    Evita que las peticiones de polling (/status, /api/metrics) inunden la terminal
    siempre que la respuesta sea exitosa (200 o 304).
    Si ocurre un error (500, 404), el log se mantendrá para depuración.
    """
    def filter(self, record):
        msg = record.getMessage()
        # Definimos las rutas que generan ruido (polling constante)
        polling_routes = ["/status", "/api/metrics", "/api/servers", "/api/groups"]
        
        # Verificamos si la petición es una de las rutas de polling
        is_polling = any(route in msg for route in polling_routes)
        
        # Verificamos si es una respuesta exitosa (evitamos silenciar errores reales)
        is_success = " 200 " in msg or " 304 " in msg
        
        # Si es polling y es éxito, filtramos el registro (return False)
        if is_polling and is_success:
            return False
            
        return True

def apply_logging_filters():
    """Aplica el filtro de polling al logger de werkzeug."""
    logging.getLogger("werkzeug").addFilter(PollingFilter())
