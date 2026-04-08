from flask import Flask
import os
from .utils import apply_logging_filters

def create_app():
    # Base directory is one level up from app/
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    
    app = Flask(
        __name__,
        static_folder=os.path.join(base_dir, "static"),
        template_folder=os.path.join(base_dir, "templates")
    )
    
    app.secret_key = "winrm-monitor-key-2026"
    
    # Apply filters
    apply_logging_filters()
    
    # Register routes
    from .routes import main_bp
    app.register_blueprint(main_bp)
    
    return app
