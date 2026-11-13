FROM python:3.12-slim

WORKDIR /app

COPY . /app

ENV HOST=0.0.0.0
ENV PORT=8080
ENV DATA_DIR=/app/data

RUN mkdir -p /app/data

EXPOSE 8080

CMD ["python", "server.py"]
