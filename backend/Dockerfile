FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 poppler-utils tesseract-ocr tesseract-ocr-chi-tra tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py product_library.py ./
COPY pdf_rebuild.py poster_pdf.py poster_auto.py vision_llm.py workflow.py auth.py campaign_template.py campaigns.py archives.py cutout_jobs.py model_cache.py ./
ENV U2NET_HOME=/models OMP_NUM_THREADS=2 POSTER_DATA_DIR=/data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3)" || exit 1
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log", "--log-level", "error"]
