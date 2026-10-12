# Deploying MyoMate CloudHub to Google Cloud Run

This guide explains how to deploy **MyoMate CloudHub** (the WebSocket Telemetry Hub + 1D-CNN AI Engine) to **Google Cloud Run**.

---

## Why Google Cloud Run?

1. **Native WebSocket Support**: Cloud Run maintains long-lived bidirectional WebSocket connections automatically with zero extra configuration.
2. **Built-in HTTPS & WSS**: Free, managed SSL certificates are provisioned automatically.
3. **Serverless & Cost-Effective**: Only scales and charges when active.
4. **No Local Docker Needed**: Google Cloud Build compiles the `Dockerfile` directly from your GitHub repository in the cloud.

---

## Method 1: 1-Click Deployment via Google Cloud Console (Recommended)

Since your code is pushed to [https://github.com/arjunjsatish/myomate](https://github.com/arjunjsatish/myomate), you can deploy directly from your browser without installing `gcloud` or Docker on your Mac:

### Step 1: Open Cloud Run in Google Cloud Console
1. Go to the [Google Cloud Run Console](https://console.cloud.google.com/run).
2. Ensure you have selected your desired Google Cloud Project.
3. Click **"Create Service"** (or **"+ Deploy container"**).

### Step 2: Connect Your GitHub Repository
1. In the service setup screen, choose:
   - **"Continuously deploy from a repository"** -> Click **"Set up with Cloud Build"**.
2. Select **GitHub** as the repository provider and authenticate.
3. Select your repository: **`arjunjsatish/myomate`**.
4. Branch: **`^main$`**.
5. Build Type: **Dockerfile** (Path: `/Dockerfile`).
6. Click **Save**.

### Step 3: Configure Service Settings
1. **Service Name**: `myomate-cloudhub`
2. **Region**: Choose a region close to you (e.g., `us-central1` or `us-east1`).
3. **Authentication**: Select **"Allow unauthenticated invocations"** (allows remote browsers and the Edge Gateway to connect over HTTPS/WSS).
4. Click **"Container, Networking, Security"** (advanced settings):
   - **Memory**: Set to **`1 GiB`** or **`2 GiB`** (plenty for the PyTorch 1D-CNN model).
   - **CPU**: Set to **`1`**.
   - **Session Affinity**: Check **"Turn on session affinity"** *(Important: keeps WebSocket clients connected to the same active instance).*
   - **Request Timeout**: Set to **`3600`** seconds (1 hour, allows uninterrupted live telemetry streaming sessions).
5. Click **"Create"**.

Google Cloud Build will automatically build the container and deploy it. In ~2 minutes, you will receive a secure URL such as:
```
https://myomate-cloudhub-xxxx-uc.a.run.app
```

---

## Method 2: Deployment via Google Cloud Shell / `gcloud` CLI

If you prefer the command line, open the [Google Cloud Shell](https://shell.cloud.google.com/) and run:

```bash
# Clone the repository into Cloud Shell
git clone https://github.com/arjunjsatish/myomate.git
cd myomate

# Deploy directly to Cloud Run
gcloud run deploy myomate-cloudhub \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --memory 1Gi \
  --cpu 1 \
  --session-affinity \
  --timeout 3600
```

---

## Connecting Your Local Hardware to the Cloud Hub

Once your Cloud Run service is deployed, connect your local ESP32 hardware gateway to your cloud URL:

On your Mac connected to `/dev/cu.usbserial-02E4CA0A`:

```bash
cd "/Users/arjun_1/Documents/ESP Hardware"

# Start the Edge Gateway pointing to your Google Cloud Run WSS endpoint:
CLOUD_WS_URL=wss://myomate-cloudhub-xxxx-uc.a.run.app npm run edge
```

### Result:
- Your local Mac captures live 512 Hz ECG from the ESP32.
- Telemetry streams via encrypted WebSockets (`wss://`) up to Google Cloud.
- Any doctor, patient, or reviewer anywhere in the world can open:
  ```
  https://myomate-cloudhub-xxxx-uc.a.run.app
  ```
  to view the real-time strip, record sessions, and run 1D-CNN AI arrhythmia analyses directly in the cloud!
