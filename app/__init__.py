from flask import Flask
import os
from datetime import timedelta
from .utils import apply_logging_filters

def create_app():
    # Base directory is one level up from app/
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    
    app = Flask(
        __name__,
        static_folder=os.path.join(base_dir, "static"),
        template_folder=os.path.join(base_dir, "templates")
    )
    
    app.secret_key = os.getenv("SECRET_KEY", "winrm-monitor-key-production-2026")
    
    # 2. Security Config
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Lax',
        PERMANENT_SESSION_LIFETIME=timedelta(days=7),
        # Ensure session tokens are only sent over HTTPS in production
        SESSION_COOKIE_SECURE=os.getenv("PG_HOST", "localhost") != "localhost"
    )

    # 3. Apply filters
    from .utils import apply_logging_filters
    apply_logging_filters()
    
    # Register routes
    from .routes import main_bp
    app.register_blueprint(main_bp)
    
    return app
