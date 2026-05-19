"""Flask application factory."""

from pathlib import Path
from flask import Flask
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

limiter = Limiter(key_func=get_remote_address, default_limits=[])


def create_app() -> Flask:
    app = Flask(
        __name__,
        template_folder=str(Path(__file__).parent.parent / "templates"),
        static_folder=str(Path(__file__).parent.parent / "static"),
    )
    app.secret_key = "dope-calculator-dev-key"

    limiter.init_app(app)

    from .database import init_db
    with app.app_context():
        init_db()

    from .routes import bp
    app.register_blueprint(bp)

    return app
