FROM node:22-bookworm-slim AS frontend-build
WORKDIR /frontend
COPY app/frontend/package*.json ./
COPY app/frontend/patches ./patches
RUN npm ci --no-audit --no-fund
COPY app/frontend/src ./src
RUN mkdir -p /build && ./node_modules/.bin/esbuild src/main.jsx --bundle --minify --target=es2020 --outfile=/build/planner.bundle.js

FROM python:3.11-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/srv/app

WORKDIR /srv/app
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && useradd --system --uid 10001 --create-home planner \
    && mkdir -p /data \
    && chown -R planner:planner /data /srv/app
COPY --chown=planner:planner app /srv/app/app
COPY --from=frontend-build --chown=planner:planner /build/planner.bundle.js /srv/app/app/static/planner.bundle.js
USER planner

FROM runtime AS test
USER root
COPY requirements-dev.txt /tmp/requirements-dev.txt
COPY pytest.ini /srv/app/pytest.ini
RUN pip install --no-cache-dir -r /tmp/requirements-dev.txt
USER planner
RUN python -m pytest app/tests/test_app.py -q --tb=short -p no:cacheprovider

FROM runtime AS production
EXPOSE 8789
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8789", "--proxy-headers", "--forwarded-allow-ips", "172.17.0.1"]
