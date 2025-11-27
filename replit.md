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

## UI Design System
The application uses a modern SaaS-style design with:
- **Dark sidebar navigation** (slate-900 background) with expandable sections
- **Light content areas** (gray-50/white backgrounds) with card-based layouts
- **Blue accents** (#3B82F6 / blue-600) for primary actions and highlights
- **Tailwind CSS v4** with @import syntax instead of @tailwind directives

### Key UI Components
- `components/ui/Sidebar.tsx` - Dark navigation sidebar with search and expandable menus
- `components/ui/AppLayout.tsx` - Main layout wrapper with sidebar integration
- `app/login/LoginForm.tsx` - Modern login form with icons and validation
- `app/dashboard/DashboardClient.tsx` - Dashboard with stats cards, search, and data table

## Recent Changes
- **2024-11-27**: UI Modernization
  - Redesigned login page with centered card layout and blue icon branding
  - Added dark sidebar navigation component with expandable settings menu
  - Updated dashboard with stat cards, search functionality, and modern table design
  - Created tabbed vehicle detail page with Attributes, Recs, and History tabs
  - Standardized design patterns across all updated components
  - Fixed Tailwind CSS v4 configuration (@import syntax)
  
- **2024-11-27**: Initial Replit setup
  - Configured Next.js to run on port 5000 with host 0.0.0.0
  - Set up MongoDB local instance
  - Added experimental.allowedOrigins configuration for Replit proxy
  - Configured deployment settings for autoscale
  - Added .replitrc for automatic MongoDB startup
