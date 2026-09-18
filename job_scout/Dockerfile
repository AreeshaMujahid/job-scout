# The stateless rating and classification service (job_scout/service.py).
#
# Owns no data: it reads CVs, searches boards, rates jobs and reads e-mail
# for status changes, and keeps none of it. Everything worth keeping lives in
# the web app's Postgres.

FROM python:3.12-slim

# PyMuPDF wheels need nothing to build, but the PDF work wants fonts present
# for anything that renders rather than extracts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY job_scout/requirements.txt ./job_scout/requirements.txt
# Everything comes from requirements.txt. It used to name the server
# packages here instead, which meant the image worked while a plain
# `pip install -r requirements.txt` did not -- the file and the
# container disagreed about what this service needs.
RUN pip install --no-cache-dir -r job_scout/requirements.txt

COPY job_scout ./job_scout
# Beside the package, not inside it: sources/scrapers.py adds the directory
# above job_scout/ to sys.path and imports this by name. Without it the
# LinkedIn, Xing and Arbeitnow boards silently vanish from the container.
COPY linkedin.py ./linkedin.py

RUN useradd --create-home scout
USER scout

# Bound to all interfaces because it has to be reachable from the app
# container. It is not published to the host in docker-compose.yml, and
# SCOUT_TOKEN is required, so "reachable" means "from the compose network".
ENV SCOUT_HOST=0.0.0.0 SCOUT_PORT=8000
EXPOSE 8000
CMD ["python", "-m", "job_scout.service"]
