# Deployment Guide

This guide covers deploying MOS Maintenance MVP to Replit, Render, or other hosting platforms.

---

## Platform Overview

| Platform | Best For | Background Workers | Complexity |
|----------|----------|-------------------|------------|
| **Replit** | Development, testing | Separate workflows | Low |
| **Render** | Production | Combined script or cron jobs | Medium |
| **Vercel** | Frontend-focused | External cron service needed | Medium |
| **VPS** | Full control | PM2 or systemd | High |

---

## Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `MONGODB_URI` | Full MongoDB connection string | `mongodb+srv://user:pass@cluster.mongodb.net/db` |
| `MONGODB_DB` | Database name | `mos-maintenance-mvp` |
| `SESSION_SECRET` | 32+ character random string | `your-secret-key-here-32-chars-min` |
| `NODE_ENV` | Environment mode | `production` |

**Alternative MongoDB Config** (if not using MONGODB_URI):
| Variable | Description |
|----------|-------------|
| `MONGODB_USERNAME` | MongoDB Atlas username |
| `MONGODB_PASSWORD` | MongoDB Atlas password |

### OpenAI Configuration

The app supports two OpenAI modes:

| Variable | When to Use |
|----------|-------------|
| `OPENAI_API_KEY` | **Self-hosted**: Your own OpenAI API key |
| `AI_INTEGRATIONS_OPENAI_API_KEY` | **Replit only**: Auto-provided by Replit |
| `AI_INTEGRATIONS_OPENAI_BASE_URL` | **Replit only**: Auto-provided by Replit |

**Priority**: If `OPENAI_API_KEY` is set, it will be used. Otherwise falls back to Replit's integration.

### Integration Variables (Optional)

| Variable | Integration |
|----------|-------------|
| `TEKMETRIC_CLIENT_ID` | Tekmetric OAuth client ID |
| `TEKMETRIC_CLIENT_SECRET` | Tekmetric OAuth client secret |
| `CARFAX_PDI` | CARFAX vehicle history |
| `CARFAX_POST_URL` | CARFAX API endpoint |
| `DATAONE_API_URL` | DataOne VIN decoder |

### Development Only (Do NOT set in production)

| Variable | Description |
|----------|-------------|
| `DEV_AUTO_LOGIN` | Auto-login bypass (development only) |
| `DEV_SHOP_ID` | Dev shop ID |
| `DEV_USER_EMAIL` | Dev user email |

---

## Deployment Options

### Option 1: Replit (Development & Testing)

Replit is ideal for development, testing, and demos. The app runs with separate workflows for the web server and background sync workers.

#### Workflows Configuration

The app uses these Replit workflows:

| Workflow | Command | Purpose |
|----------|---------|---------|
| **MOS Maintenance MVP** | `npm run dev` | Main Next.js web server |
| **Tekmetric Sync Worker** | `npx tsx scripts/tekmetric-sync-worker.ts` | Polls Tekmetric API for active ROs |
| **Protractor Sync Worker** | `npx tsx scripts/protractor-sync-worker.ts` | Syncs Protractor shop data |
| **Protractor Backfill Worker** | `npx tsx scripts/protractor-backfill-worker.ts` | Historical data backfill |

#### Starting the App

1. **Start the main workflow**: Click "Run" or start "MOS Maintenance MVP"
2. **Start sync workers** (optional): Start "Tekmetric Sync Worker" if you need real-time RO polling

#### When You DON'T Need Sync Workers

You can skip running sync workers if:
- **Webhooks are configured**: Tekmetric sends real-time updates to `/api/webhooks/tekmetric`
- **Testing only**: You're just testing the UI or sticker generation
- **Manual sync**: Users can click "Sync Now" in Settings → Integrations

#### Replit Environment Variables

Replit auto-provides some variables. Add these in the Secrets tab:
```
MONGODB_USERNAME=your_username
MONGODB_PASSWORD=your_password
TEKMETRIC_CLIENT_ID=your_client_id
TEKMETRIC_CLIENT_SECRET=your_client_secret
HOVERCODE_API_TOKEN=your_token
HOVERCODE_WORKSPACE_ID=your_workspace
STRIPE_SECRET_KEY=your_stripe_key
```

**Note**: `AI_INTEGRATIONS_OPENAI_API_KEY` is auto-provided by Replit's OpenAI integration.

---

### Option 2: Render (Production)

Render offers two deployment types. Choose based on your needs:

#### Option A: Autoscale (Recommended for Cost)

Autoscale deployments scale to zero when idle - great for cost savings. **Background workers are NOT supported** in Autoscale, so use webhooks or cron jobs for sync.

1. **Create Web Service**
   - Go to [render.com](https://render.com)
   - Click "New" → "Web Service"
   - Connect your GitHub repository
   - Select **Autoscale** deployment type

2. **Configure Settings**
   - **Name**: `mos-maintenance`
   - **Runtime**: Node
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `node scripts/start-production.js`
   - **Health Check Path**: `/api/health`

3. **Add Environment Variables**
   ```
   NODE_ENV=production
   MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/db
   MONGODB_DB=mos-maintenance-mvp
   SESSION_SECRET=your-32-character-secret-here
   OPENAI_API_KEY=sk-your-openai-key
   TEKMETRIC_CLIENT_ID=your-client-id
   TEKMETRIC_CLIENT_SECRET=your-client-secret
   ```

4. **Set Up Data Sync** (pick one):
   - **Webhooks**: Configure Tekmetric to send updates to `https://your-app.onrender.com/api/webhooks/tekmetric`
   - **Cron Job**: Create a Render Cron Job to call `/api/cron/tekmetric-sync` every 5 minutes

5. **Deploy** - Render will build and deploy automatically

#### Option B: Reserved VM (For Background Workers)

Reserved VM runs continuously - required if you want background sync workers running 24/7.

1. **Create Web Service**
   - Select **Reserved VM** deployment type

2. **Configure Settings**
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `node scripts/start-with-workers.js`
   - **Instance Type**: Starter or higher

3. **Add Environment Variables** (same as Option A, plus):
   ```
   PRODUCTION_URL=https://your-app.onrender.com
   ```

4. **Deploy** - Workers will run continuously alongside the web server

#### Option C: Separate Background Worker Service

For best reliability, run the web app and workers as separate services:

1. **Web Service** (Autoscale or Reserved VM)
   - Start Command: `node scripts/start-production.js`

2. **Background Worker** (separate service)
   - Type: Background Worker
   - Start Command: `npx tsx scripts/tekmetric-sync-worker.ts`
   - Add `PRODUCTION_URL=https://your-web-service.onrender.com`

---

### Option 3: Vercel

Vercel works well for the web app but requires an external service for background workers.

1. **Connect Repository**
   ```bash
   git push origin main
   ```

2. **Import to Vercel**
   - Go to [vercel.com](https://vercel.com)
   - Click "New Project" → Import your repository
   - Framework: Next.js (auto-detected)

3. **Configure Environment Variables**
   - Go to Project Settings → Environment Variables
   - Add all required variables from the table above

4. **Background Sync Options**
   - **Vercel Cron**: Use `vercel.json` to schedule `/api/cron/tekmetric-sync`
   - **External Cron**: Use services like cron-job.org to call the sync endpoint
   - **Webhooks Only**: Rely on Tekmetric webhooks for real-time updates

5. **Deploy** - Vercel auto-deploys on every push to main

---

### Option 4: VPS / Self-Hosted

1. **Prerequisites**
   ```bash
   # Node.js 20+
   node --version  # Should be 20.x or higher
   
   # npm or yarn
   npm --version
   ```

2. **Clone & Install**
   ```bash
   git clone https://github.com/crusher0311/mos-maint.git
   cd mos-maint
   npm install
   ```

3. **Create Environment File**
   ```bash
   # Create .env.local (never commit this file)
   cat > .env.local << EOF
   NODE_ENV=production
   MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/db
   MONGODB_DB=mos-maintenance-mvp
   SESSION_SECRET=your-32-character-secret-here
   OPENAI_API_KEY=sk-your-openai-key
   EOF
   ```

4. **Build & Start**
   ```bash
   npm run build
   npm start
   ```

5. **Production Process Manager (recommended)**
   ```bash
   # Using PM2
   npm install -g pm2
   pm2 start npm --name "mos-maint" -- start
   pm2 save
   pm2 startup
   ```

### Option 3: Docker

1. **Create Dockerfile** (if not present)
   ```dockerfile
   FROM node:20-alpine
   WORKDIR /app
   COPY package*.json ./
   RUN npm ci --only=production
   COPY . .
   RUN npm run build
   EXPOSE 3000
   CMD ["npm", "start"]
   ```

2. **Build & Run**
   ```bash
   docker build -t mos-maint .
   docker run -p 3000:3000 --env-file .env.local mos-maint
   ```

---

## Database Setup

### MongoDB Atlas (Recommended)

1. Create a cluster at [mongodb.com/atlas](https://mongodb.com/atlas)
2. Create a database user with read/write permissions
3. Whitelist your server's IP (or 0.0.0.0/0 for Vercel)
4. Copy the connection string to `MONGODB_URI`

### Create Indexes

Run the index creation script after first deployment:
```bash
npx tsx scripts/add-indexes.ts
```

---

## Post-Deployment Checklist

- [ ] All environment variables configured
- [ ] MongoDB accessible from deployment server
- [ ] Login/registration works
- [ ] Dashboard loads correctly
- [ ] OpenAI features functional (test a vehicle analysis)
- [ ] Integrations connected (Tekmetric, CARFAX, etc.)

---

## Troubleshooting

### Build Failures
- Verify all environment variables are set
- Check MongoDB connectivity
- Review build logs

### OpenAI Not Working
- Verify `OPENAI_API_KEY` is set correctly
- Test with a simple API call
- Check usage limits on your OpenAI account

### Session/Auth Issues
- Ensure `SESSION_SECRET` is set and consistent
- Check cookie settings match your domain (HTTPS required)
- Verify MongoDB sessions collection is accessible

### Database Connection Errors
- Confirm MongoDB URI is correct
- Check IP whitelist includes your server
- Verify database user permissions

---

## Platform Comparison

| Feature | Replit | Render | Vercel | VPS |
|---------|--------|--------|--------|-----|
| **OpenAI** | Auto (AI_INTEGRATIONS_*) | Your own key | Your own key | Your own key |
| **Port** | 5000 (required) | Any (default 3000) | Auto | Any |
| **HTTPS** | Auto | Auto | Auto | Configure nginx |
| **Background Workers** | Separate workflows | Combined script or cron | External cron | PM2/systemd |
| **Webhooks** | Supported | Supported | Supported | Supported |
| **Best For** | Development | Production | Frontend-heavy | Full control |

### Background Sync Options Summary

| Method | Pros | Cons |
|--------|------|------|
| **Webhooks Only** | Real-time, no workers needed | Requires Tekmetric webhook setup |
| **Polling Workers** | Works without webhook config | Uses resources continuously |
| **Cron Jobs** | Simple, periodic sync | May miss updates between syncs |
| **Combined Script** | Easy single-process deploy | All eggs in one basket |

---

## Security Reminders

- Never commit `.env.local` or secrets to git
- Use strong, unique `SESSION_SECRET`
- Rotate API keys periodically
- Keep `DEV_AUTO_LOGIN` disabled in production
- Use HTTPS in production (Vercel handles this automatically)
