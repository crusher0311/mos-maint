# MOS Maintenance MVP

An automotive maintenance management system built with Next.js that streamlines operations for auto shops by providing tools for managing vehicle maintenance recommendations, customer data, and oil change sticker generation.

## Features

### Core Platform
- **Vehicle Dashboard**: View and manage active repair orders from Tekmetric
- **AI-Powered Recommendations**: Maintenance suggestions based on OEM schedules, vehicle history, and shop patterns
- **Multi-Shop Management**: Role-based access control with enterprise support
- **Customer Tracking**: Manage customer information and vehicle history

### My Oil Sticker (MVP)
- **Sticker Generation**: Create professional oil change reminder stickers
- **HoverCode QR Integration**: Dynamic, trackable QR codes for customer appointments
- **Chrome Extension**: Print stickers directly from Tekmetric repair orders
- **Customization**: Logo, colors, contact info, taglines, and service intervals
- **Multi-Unit Support**: Miles, kilometers, or hours

### Integrations
- **Tekmetric**: Real-time sync of repair orders and vehicle data
- **Protractor**: Legacy shop management system support
- **CARFAX**: Vehicle history and mileage predictions
- **Stripe**: Subscription billing and usage tracking

## Getting Started

### Prerequisites
- Node.js 18+
- MongoDB Atlas account
- Tekmetric API access (for shop integration)

### Environment Variables
Copy `.env.example` to `.env` and configure:
```bash
MONGODB_USERNAME=your_username
MONGODB_PASSWORD=your_password
TEKMETRIC_API_TOKEN=your_token
HOVERCODE_API_TOKEN=your_token
HOVERCODE_WORKSPACE_ID=your_workspace
```

### Development
```bash
npm install
npm run dev
```

The app runs on [http://localhost:5000](http://localhost:5000).

### Workers
Background sync workers run automatically:
- **Tekmetric Sync Worker**: Polls active repair orders every 10 seconds
- **Protractor Sync Worker**: Syncs Protractor shop data

## Architecture

- **Framework**: Next.js 14.2.5 with React 18
- **Database**: MongoDB Atlas
- **Styling**: Tailwind CSS
- **API**: Next.js API Routes
- **Workers**: TypeScript scripts with adaptive backoff

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for production deployment instructions.

## Chrome Extension

The MOS Tools Chrome Extension (v1.4.6) provides:
- Sticker tab for printing oil change stickers from Tekmetric ROs
- Plan tab for viewing maintenance recommendations
- Lookup tab for searching job history
- Canned Jobs tab for quick job access

See `mos-tools-extension/` for extension source code.

## License

Proprietary - All rights reserved
