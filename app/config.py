from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo


@dataclass(frozen=True, slots=True)
class Settings:
    todoist_token: str
    todoist_project: str
    app_password: str
    session_secret: str
    database_path: Path
    timezone: str
    allowed_hosts: tuple[str, ...]
    cookie_secure: bool = True

    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    @classmethod
    def from_env(cls) -> "Settings":
        token = os.getenv("TODOIST_TOKEN", "").strip()
        token_file = os.getenv("TODOIST_TOKEN_FILE", "/run/secrets/todoist-token").strip()
        if not token and token_file:
            try:
                token = Path(token_file).read_text(encoding="utf-8").strip()
            except FileNotFoundError:
                pass
        return cls(
            todoist_token=token,
            todoist_project=os.getenv("TODOIST_PROJECT", "Meals").strip() or "Meals",
            app_password=os.getenv("APP_PASSWORD", ""),
            session_secret=os.getenv("SESSION_SECRET", ""),
            database_path=Path(os.getenv("DATABASE_PATH", "/data/meals.sqlite3")),
            timezone=os.getenv("TZ", "Asia/Kolkata"),
            allowed_hosts=tuple(
                x.strip() for x in os.getenv(
                    "ALLOWED_HOSTS",
                    "meals.happydaysblr.ddns.net,localhost,127.0.0.1,testserver",
                ).split(",") if x.strip()
            ),
            cookie_secure=os.getenv("COOKIE_SECURE", "true").lower() in {"1", "true", "yes", "on"},
        )

    def validate(self) -> None:
        if not self.app_password:
            raise RuntimeError("APP_PASSWORD must be set")
        if len(self.session_secret) < 32:
            raise RuntimeError("SESSION_SECRET must contain at least 32 characters")
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
