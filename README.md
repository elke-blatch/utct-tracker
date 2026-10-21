# UTCT 100km Live Tracker

Live tracking app for Ben's UTCT 100km race. Ben runs the tracker page on his phone to send GPS pings; the crew watches the viewer dashboard to see his live position on the map.

## Deploy to Render.com

1. Go to https://render.com and create a free account
2. Click **New +** → **Web Service**
3. Connect your GitHub account and select this repository
4. Render will auto-detect Python from requirements.txt
5. Settings:
   - **Name:** utct-100km-tracker (or whatever you like)
   - **Runtime:** Python 3
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --timeout 120`
6. Click **Create Web Service**
7. Wait 2-5 minutes for the build
8. You'll get a URL like `https://utct-100km-tracker.onrender.com`

## URLs

- **Viewer dashboard (crew):** `https://your-app-url.onrender.com/`
- **Phone tracker (Ben):** `https://your-app-url.onrender.com/tracker`

## Add to iPhone Home Screen

1. Open the tracker URL in Safari
2. Tap Share → Add to Home Screen
3. The UTCT logo appears as the app icon
