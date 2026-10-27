FROM python:3.12-alpine

RUN pip install --no-cache-dir aiohttp==3.10.10

COPY proxy.py /proxy.py

CMD ["python3", "-u", "/proxy.py"]
