# AgriRent AI — multilingual semantic double-check service.
# Hugging Face Spaces (Docker SDK). See README.md for deploy instructions —
# this Dockerfile only runs after a Space is created and this folder pushed
# to it; it is not built by the main repo's CI/CD.

FROM python:3.11-slim

# Hugging Face Spaces run the container as a non-root user by convention;
# give that user a writable home so sentence-transformers/huggingface_hub
# can cache the downloaded model under $HOME/.cache instead of failing on a
# read-only /root.
RUN useradd -m -u 1000 appuser
ENV HOME=/home/appuser \
    PATH=/home/appuser/.local/bin:$PATH \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY --chown=appuser:appuser requirements.txt .
USER appuser
RUN pip install --user -r requirements.txt

COPY --chown=appuser:appuser app.py .

# Matches this folder's README.md `app_port: 7860` front-matter — Hugging
# Face Spaces routes external traffic to this port.
EXPOSE 7860

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
