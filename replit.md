# MOS Maintenance MVP

## Overview
This is a Next.js-based automotive maintenance management system that helps shops manage vehicle maintenance recommendations, customer data, and integrations with third-party services like AutoFlow and CARFAX.

## Tech Stack
- **Frontend**: Next.js 14.2.5 with React 18
- **Backend**: Next.js API Routes (serverless functions)
- **Database**: MongoDB (local instance on port 27017)
- **Styling**: Tailwind CSS
- **Language**: TypeScript/JavaScript

## Project Structure
- `app/` - Next.js app router pages and layouts
- `app/api/` - API routes for backend functionality
- `components/` - Reusable React components
- `lib/` - Utility functions and database connections
- `public/` - Static assets
- `scripts/` - Database migration and setup scripts

## Environment Setup

### Required Environment Variables
- `MONGODB_URI` - MongoDB connection string (currently: mongodb://localhost:27017/mos-maintenance-mvp)
- `MONGODB_DB` - Database name (default: mos-maintenance-mvp)
- `SESSION_SECRET` - Secret for session management
- `ADMIN_TOKEN` - Admin access token for initial setup

### Optional Integrations
- `OPENAI_API_KEY` - For AI-powered maintenance recommendations
- AutoFlow, CARFAX, and DataOne integrations (see .env.example for details)

## Development

### Running Locally
The dev server runs on port 5000 (configured for Replit):
```bash
npm run dev
```

### MongoDB
MongoDB runs locally on port 27017. The `.replitrc` script automatically starts MongoDB on boot.

### Key Features
1. **Vehicle Analysis** - AI-powered maintenance recommendations based on vehicle history
2. **Customer Dashboard** - Track customers and their vehicles
3. **AutoFlow Integration** - Sync repair orders and vehicle data
4. **Authentication** - Multi-shop user management with role-based access

## Deployment
The app is configured for Replit autoscale deployment:
- Build command: `npm run build`
- Start command: `npm run start`
- Port: 5000

## Database Collections
- `customers` - Customer records
- `vehicles` - Vehicle information
- `repair_orders` - Service repair orders
- `events` - Integration webhook events
- `users` - User accounts
- `shops` - Shop configurations
- `sessions` - User sessions
- `ai_analysis_cache` - Cached AI analysis results

## Recent Changes
- **2024-11-27**: Initial Replit setup
  - Configured Next.js to run on port 5000 with host 0.0.0.0
  - Set up MongoDB local instance
  - Added experimental.allowedOrigins configuration for Replit proxy
  - Configured deployment settings for autoscale
  - Added .replitrc for automatic MongoDB startup
