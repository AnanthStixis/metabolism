# Static site — no build step, just serve the files with nginx over HTTPS.
# HTTPS (even self-signed) is required because browsers only allow camera
# access (getUserMedia) from a secure context — plain HTTP would silently
# fail the "Start Camera" button.
FROM nginx:alpine

RUN apk add --no-cache openssl \
  && mkdir -p /etc/nginx/ssl \
  && openssl req -x509 -nodes -days 825 \
       -newkey rsa:2048 \
       -keyout /etc/nginx/ssl/selfsigned.key \
       -out /etc/nginx/ssl/selfsigned.crt \
       -subj "/CN=glixify-qa" \
       -addext "subjectAltName=DNS:localhost,DNS:*.local,IP:127.0.0.1"

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY index.html /usr/share/nginx/html/index.html
COPY app.js /usr/share/nginx/html/app.js
COPY style.css /usr/share/nginx/html/style.css
COPY rules.js /usr/share/nginx/html/rules.js
COPY vitals.js /usr/share/nginx/html/vitals.js
COPY questionnaire.js /usr/share/nginx/html/questionnaire.js
COPY snapshot.js /usr/share/nginx/html/snapshot.js
COPY sdk/glixify-vitals-sdk.js /usr/share/nginx/html/sdk/glixify-vitals-sdk.js

EXPOSE 443
