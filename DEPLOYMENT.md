# Deployment Guide

This guide covers deploying MOS Maintenance MVP to any hosting platform.

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
| `TEKMETRIC_API_TOKEN` | Tekmetric shop management |
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

### Option 1: Vercel (Recommended)

1. **Connect Repository**
   ```bash
   # Push to GitHub first
   git push origin main
   ```

2. **Import to Vercel**
   - Go to [vercel.com](https://vercel.com)
   - Click "New Project" → Import your repository
   - Framework: Next.js (auto-detected)

3. **Configure Environment Variables**
   - Go to Project Settings → Environment Variables
   - Add all required variables from the table above
   - Set for "Production" environment

4. **Deploy**
   - Vercel auto-deploys on every push to main

### Option 2: Render

1. **Create Web Service**
   - Go to [render.com](https://render.com)
   - Click "New" → "Web Service"
   - Connect your GitHub repository

2. **Configure Settings**
   - **Name**: `mos-maintenance`
   - **Runtime**: Node
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Instance Type**: Starter or higher

3. **Add Environment Variables**
   In the "Environment" section, add:
   ```
   NODE_ENV=production
   MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/db
   MONGODB_DB=mos-maintenance-mvp
   SESSION_SECRET=your-32-character-secret-here
   OPENAI_API_KEY=sk-your-openai-key
   ```

4. **Deploy**
   - Click "Create Web Service"
   - Render will build and deploy automatically
   - Auto-deploys on every push to your connected branch

5. **Custom Domain (Optional)**
   - Go to Settings → Custom Domains
   - Add your domain and configure DNS

### Option 3: VPS / Self-Hosted

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

## Replit vs Self-Hosted Differences

| Feature | Replit | Self-Hosted |
|---------|--------|-------------|
| OpenAI | Uses AI_INTEGRATIONS_* (auto) | Use your own OPENAI_API_KEY |
| Port | 5000 (required) | 3000 (default) or custom |
| HTTPS | Auto-managed | Configure reverse proxy (nginx) |
| Database | MongoDB Atlas | MongoDB Atlas or self-hosted |

---

## Security Reminders

- Never commit `.env.local` or secrets to git
- Use strong, unique `SESSION_SECRET`
- Rotate API keys periodically
- Keep `DEV_AUTO_LOGIN` disabled in production
- Use HTTPS in production (Vercel handles this automatically)
