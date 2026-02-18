import { getDb } from "../lib/mongo";

interface ArticleData {
  title: string;
  problem: string;
  solution: string;
  category: string;
  tags: string[];
}

const articles: ArticleData[] = [
  // ===== GETTING STARTED =====
  {
    title: "Getting Started with MOS Maintenance",
    problem: "I'm new to MOS Maintenance and don't know where to begin or how to set up my shop.",
    solution: "Welcome to MOS Maintenance! Here's how to get started:\n\n1. **Log In**: Use the credentials provided by your administrator to log into the dashboard.\n2. **Dashboard Overview**: Your main dashboard shows key metrics, recent activity, and quick access to all features.\n3. **Shop Settings**: Navigate to Settings to configure your shop name, address, preferred distance units (miles or kilometers), and integration connections.\n4. **Connect Your Shop Management System**: Go to the Integrations page to connect Tekmetric or Protractor. This allows MOS to pull vehicle and repair order data automatically.\n5. **Install the Chrome Extension**: If you use Tekmetric, install the MOS Tools Chrome extension to get maintenance plans, sticker printing, and more right inside Tekmetric.\n6. **Explore Features**: Your available features depend on your subscription plan. Check your feature flags in Settings to see what's enabled.\n\nNeed help? Use the chat widget in the bottom-right corner anytime!",
    category: "Getting Started",
    tags: ["setup", "onboarding", "new user", "dashboard", "getting started"]
  },
  {
    title: "Understanding Your Dashboard",
    problem: "I don't understand what all the numbers and sections on my dashboard mean.",
    solution: "Your MOS dashboard is designed to give you a quick overview of your shop's activity:\n\n- **Vehicle Analysis**: Shows vehicles that have been analyzed with maintenance plans.\n- **Recent Activity**: Lists recent repair orders, plan views, and sticker prints.\n- **Quick Actions**: Shortcuts to common tasks like creating stickers or looking up vehicles.\n- **Metrics Cards**: Display key performance indicators like vehicles analyzed, stickers printed, and plans generated.\n\nThe sidebar on the left gives you access to all major sections: Vehicles, Customers, Stickers, Keytags, Settings, and more. If you have multiple shops, you can switch between them using the shop selector at the top.",
    category: "Getting Started",
    tags: ["dashboard", "overview", "metrics", "navigation"]
  },

  // ===== VEHICLE HEALTH INTELLIGENCE =====
  {
    title: "What is Vehicle Health Intelligence (VHI)?",
    problem: "I keep seeing 'Vehicle Health Intelligence' mentioned but I don't know what it is or how it works.",
    solution: "Vehicle Health Intelligence (VHI) is the core of MOS Maintenance. It's an AI-powered system that creates personalized maintenance plans for each vehicle based on:\n\n- **OEM Manufacturer Schedules**: Factory-recommended service intervals specific to the vehicle's year, make, and model.\n- **Current Mileage**: Where the vehicle is in its maintenance lifecycle.\n- **Service History**: What work has already been done (from your shop management system).\n- **Declined Services**: Services the customer previously declined that may still be needed.\n- **Digital Vehicle Inspections (DVI)**: Findings from AutoFlow or AutoVitals inspections.\n\nThe VHI plan organizes maintenance items into three priority buckets:\n- **Overdue (Red)**: Services past their recommended interval.\n- **Due Soon (Yellow)**: Services coming up within a configurable threshold.\n- **Upcoming (Green)**: Services not yet due but good to be aware of.\n\nPlans are cached for fast loading (under 500ms) and automatically refresh when repair order data changes via webhooks.",
    category: "Vehicle Health Intelligence",
    tags: ["vhi", "maintenance plan", "ai", "recommendations", "oem", "schedules"]
  },
  {
    title: "How Plan Caching and Freshness Works",
    problem: "I'm worried that the maintenance plans I'm seeing might be outdated or not reflect recent work done on a vehicle.",
    solution: "MOS uses a smart caching system to keep plans fast AND fresh:\n\n- **4-Hour Cache**: Plans are cached for 4 hours to ensure fast load times (typically under 500ms).\n- **Mileage Tolerance**: If the vehicle's mileage changes by more than 500 miles since the plan was cached, a fresh plan is automatically generated.\n- **Webhook Invalidation**: When a repair order is updated in Tekmetric (status change, new jobs added, etc.), Tekmetric sends a webhook to MOS which immediately invalidates the cached plan. The next time anyone views that vehicle's plan, a completely fresh analysis runs.\n- **Manual Refresh**: You can always force a fresh plan by refreshing the page or re-opening the vehicle in the extension.\n\nSo even though plans are cached for speed, they stay current because webhooks automatically clear the cache when relevant changes happen in your shop management system.",
    category: "Vehicle Health Intelligence",
    tags: ["cache", "freshness", "webhook", "plan", "mileage", "invalidation"]
  },
  {
    title: "Understanding Mileage Estimation (CARFAX)",
    problem: "A vehicle shows an estimated mileage in bold italic instead of an actual odometer reading. What does this mean?",
    solution: "When a vehicle's odometer reading is not explicitly entered on the work order, MOS uses CARFAX historical data to estimate the current mileage:\n\n- MOS looks at the last 3 CARFAX data points within the past 5 years.\n- It calculates a miles-per-day driving rate from this history.\n- It projects forward to estimate today's mileage.\n- At least 2 historical data points are required for an estimate.\n\n**How to identify estimated mileage:**\n- Estimated mileage displays in **bold italic** text with '(est.)' next to it.\n- Hovering over it shows a tooltip with details about how the estimate was calculated (data points used, miles/day rate, etc.).\n\n**Important:** MOS intentionally does NOT fall back to the vehicle's previously stored odometer reading. If no mileage was entered on the current work order, the field shows blank until the CARFAX estimate fills it in. This prevents old/stale mileage from being displayed as if it were current.\n\nThis ensures vehicles without a current odometer reading still get accurate maintenance plans rather than being skipped. The actual odometer reading from the repair order will be used whenever it's entered.",
    category: "Vehicle Health Intelligence",
    tags: ["mileage", "carfax", "estimation", "odometer", "bold italic", "inusage"]
  },
  {
    title: "VIN Tooltip and Vehicle Specs",
    problem: "I noticed I can hover over a VIN and see extra information. What does the tooltip show?",
    solution: "When you hover over a VIN number in the system, a tooltip appears showing service-relevant vehicle specifications:\n\n- **Front Tires**: Tire size specification for the front axle.\n- **Rear Tires**: Tire size specification for the rear axle.\n- **Front Brakes**: Brake specification for the front.\n- **Rear Brakes**: Brake specification for the rear.\n- **Wheelbase**: The vehicle's wheelbase measurement.\n\nThis information is pulled from the vehicle's VIN decode data and helps service advisors quickly reference key specs without leaving the current page. It's especially useful when writing estimates or discussing service needs with customers.",
    category: "Vehicle Health Intelligence",
    tags: ["vin", "tooltip", "specs", "tires", "brakes", "wheelbase"]
  },

  // ===== CHROME EXTENSION =====
  {
    title: "How to Use the MOS Chrome Extension",
    problem: "I installed the MOS Chrome extension but don't know how to use it with Tekmetric.",
    solution: "The MOS Chrome Extension adds a side panel to your browser that works alongside Tekmetric:\n\n1. **Opening the Extension**: Click the MOS icon in your Chrome toolbar, then click 'Open Side Panel'. The panel appears on the right side of your browser.\n2. **Automatic Detection**: When you navigate to a repair order in Tekmetric, the extension automatically detects the shop and vehicle information.\n3. **Available Tabs** (depending on your subscription):\n   - **Plan**: Shows the Vehicle Health Intelligence maintenance plan.\n   - **Failures**: AI-powered common failures analysis for the vehicle.\n   - **Lookup**: Job search with AI-scored results.\n   - **Canned**: Canned job mappings.\n   - **Sticker**: Print oil change stickers.\n   - **Keytags**: Print keytag labels.\n   - **Rates**: Labor rate rules management.\n   - **Concern**: Customer Concern Assistant for intake.\n4. **Shop-Level Pages**: Some tabs (Rates, Concern) work on any Tekmetric shop page. Others (Plan, Failures, Lookup, Sticker) require an open repair order.\n5. **Settings**: Click the gear icon to access options like default startup tab and sticker preferences.\n6. **Logout**: Click the power icon (turns red on hover) to log out.",
    category: "Chrome Extension",
    tags: ["extension", "chrome", "tekmetric", "side panel", "installation", "tabs"]
  },
  {
    title: "Extension Tabs That Require a Repair Order",
    problem: "Some tabs in the extension show a 'Repair Order Required' message. Why can't I use them?",
    solution: "The extension has two types of tabs:\n\n**Tabs that work on any Tekmetric page:**\n- Labor Rates (Rates tab)\n- Customer Concern Assistant (Concern tab)\n\nThese only need you to be on any page within a Tekmetric shop.\n\n**Tabs that require an open repair order:**\n- Vehicle Health Plan\n- Common Failures\n- Job Lookup\n- Canned Jobs\n- Oil Sticker\n- Keytags\n\nThese tabs need vehicle and repair order data to function, so you'll see a 'Repair Order Required' overlay when you're on a shop-level page without a specific RO open.\n\n**To use RO-dependent tabs:** Simply navigate to an open repair order in Tekmetric, and the extension will automatically detect the vehicle and RO information.",
    category: "Chrome Extension",
    tags: ["extension", "repair order", "tabs", "required", "overlay"]
  },
  {
    title: "Setting a Default Startup Tab in the Extension",
    problem: "The extension always opens to a tab I don't use most. Can I change which tab shows first?",
    solution: "Yes! You can set your preferred default startup tab:\n\n1. Click the **gear icon** (⚙) in the extension to open the Options page.\n2. Find the **Default Startup Tab** setting.\n3. Select your preferred tab from the dropdown.\n4. The setting is saved to your profile on the server, so it persists across devices.\n\n**Note:** Only tabs that are included in your subscription can be set as the default. Locked features will appear grayed out and can't be selected as the default. If your default tab is an RO-dependent tab and you're on a shop page without an RO, the extension will automatically switch to the first available non-RO tab.",
    category: "Chrome Extension",
    tags: ["extension", "default tab", "options", "settings", "startup"]
  },
  {
    title: "Feature-Gated Tabs and Upgrade Overlays",
    problem: "I can click on some tabs but they show a lock icon and say I need to upgrade. What does this mean?",
    solution: "MOS uses a modular feature system where shops subscribe to specific capabilities:\n\n- **Subscribed features**: Tabs work normally with full functionality.\n- **Unsubscribed features**: Tabs are still clickable, but instead of blocking access entirely, they show an **upgrade overlay** with a lock icon and the feature name.\n\nThis lets you see what additional features are available without being completely blocked. The overlay tells you which feature you'd need to subscribe to.\n\nTo unlock additional features, contact your MOS administrator or check the subscription settings in your dashboard. Available features include: Maintenance Plans, Job Lookup, Common Failures, Oil Stickers, Keytags, Auto Booking, Part Cross-Reference, Labor Rate Rules, and Customer Concern Assistant.",
    category: "Chrome Extension",
    tags: ["features", "subscription", "upgrade", "lock", "feature flags"]
  },

  // ===== OIL STICKERS & KEYTAGS =====
  {
    title: "How to Print Oil Change Stickers",
    problem: "I need to print an oil change sticker for a customer's vehicle but don't know how.",
    solution: "MOS offers two ways to print oil stickers:\n\n**From the Chrome Extension (Tekmetric users):**\n1. Open a repair order in Tekmetric.\n2. Click the **Sticker** tab in the MOS side panel.\n3. The vehicle info and next service details are pre-filled from the RO.\n4. Customize the sticker if needed (shop name, service details, next date/mileage).\n5. Toggle the QR code on or off per sticker.\n6. Click **Print** to send to your sticker printer.\n\n**From the Dashboard:**\n1. Go to **My Oil Sticker** for your standard sticker design, or **Quick Sticker** for rapid one-off prints.\n2. Enter the vehicle and service information.\n3. Customize the layout using the visual designer.\n4. Print directly to your Dymo or compatible label printer.\n\n**Smart Date Prediction:** MOS calculates the next service date using the customer's actual driving habits (miles per day), so the predicted date is personalized rather than a generic '3 months from now'.",
    category: "Stickers & Keytags",
    tags: ["sticker", "oil change", "printing", "qr code", "dymo", "label"]
  },
  {
    title: "How to Print Keytags",
    problem: "I want to print keytag labels for vehicles but I'm not sure how the keytag system works.",
    solution: "Keytag printing in MOS includes a full visual designer:\n\n1. **Access the Keytag Designer**: Go to the Keytags section from the dashboard sidebar, or use the Keytags tab in the Chrome extension.\n2. **Visual Designer**: Use the drag-and-drop editor to arrange text fields, barcodes, and shop information on the keytag layout.\n3. **Live Preview**: See exactly how your keytag will look as you make changes.\n4. **Standard & Custom Layouts**: Choose from standard templates or create your own custom layout.\n5. **Print**: Send directly to your Dymo label printer.\n\nKeytags support Dymo label printers with proper sizing and formatting built in.",
    category: "Stickers & Keytags",
    tags: ["keytag", "label", "printing", "designer", "dymo", "drag and drop"]
  },
  {
    title: "QR Codes on Stickers",
    problem: "I see a QR code option on my stickers. What does it do and can I turn it off?",
    solution: "Each oil change sticker can optionally include a QR code:\n\n- **What it does**: The QR code links to a customer-facing page with vehicle maintenance information, making it easy for customers to access their vehicle's service history and upcoming maintenance.\n- **QR Code Generation**: QR codes are generated using the HoverCode API, which provides tracking and analytics.\n- **Per-Sticker Toggle**: You can turn the QR code on or off for each individual sticker. Just use the QR code toggle switch before printing.\n- **When to use it**: Great for shops that want to provide a modern, digital experience for their customers.\n\nThe QR code is generated instantly and doesn't slow down sticker creation.",
    category: "Stickers & Keytags",
    tags: ["qr code", "sticker", "hovercode", "toggle", "customer"]
  },

  // ===== LABOR RATE RULES =====
  {
    title: "How Labor Rate Rules Work",
    problem: "I want to automatically apply specific labor rates to certain job types but don't know how to set this up.",
    solution: "Labor Rate Rules let you define automatic pricing adjustments that the Chrome extension applies in the background:\n\n1. **Access Rules**: Go to the **Rates** tab in the Chrome extension (works on any Tekmetric shop page - no repair order needed).\n2. **Create Rules**: Define rules that match job names or categories and specify the labor rate to apply.\n3. **Automatic Application**: When you're working in Tekmetric, the extension checks repair orders against your rules and automatically applies the correct labor rates.\n4. **Toast Notifications**: When a rule is applied, you'll see a brief notification confirming the rate was updated.\n\n**Key Benefits:**\n- Saves time by eliminating manual rate adjustments.\n- Ensures consistency across all service advisors.\n- Rules are visible and manageable from the extension UI.\n- Changes take effect immediately.\n\nLabor Rate Rules require the 'labor_rates' feature to be enabled in your subscription.",
    category: "Labor Rate Rules",
    tags: ["labor rate", "rules", "automation", "pricing", "tekmetric", "toast"]
  },

  // ===== CUSTOMER CONCERN ASSISTANT =====
  {
    title: "Using the Customer Concern Assistant",
    problem: "I heard there's an AI tool that helps with customer concern intake. How do I use it?",
    solution: "The Customer Concern Assistant is an AI-powered tool that helps service advisors build structured, professional customer concern write-ups:\n\n1. **Access**: Open the **Concern** tab in the Chrome extension (works on any Tekmetric shop page).\n2. **Start a Conversation**: Enter the customer's initial concern (e.g., 'car makes a squealing noise when braking').\n3. **AI Follow-Up Questions**: The AI generates targeted follow-up questions to gather more details (e.g., 'Does the noise occur at all speeds or only when stopping from high speed?').\n4. **Review Round**: After answering follow-ups, the AI may ask additional clarifying questions based on your answers.\n5. **Professional Write-Up**: Once enough information is gathered, the AI produces a clean, professional concern description.\n6. **Auto-Inject**: The write-up can be automatically injected into the Tekmetric repair order's concern field.\n\n**Benefits:**\n- Ensures consistent, thorough concern documentation.\n- Helps new service advisors ask the right questions.\n- Produces professional write-ups every time.\n- Conversations are saved for reference.\n\nRequires the 'concern_assistant' feature flag to be enabled.",
    category: "Customer Concern Assistant",
    tags: ["concern", "assistant", "ai", "intake", "follow-up", "write-up", "tekmetric", "protractor"]
  },

  // ===== COMMON FAILURES =====
  {
    title: "What is the Common Failures Advisor?",
    problem: "I see a 'Failures' tab in the extension. What does it do?",
    solution: "The Common Failures Advisor uses AI to analyze a specific vehicle (year, make, model, engine) and identify its most commonly reported problems and failure points:\n\n- **AI-Powered**: Uses OpenAI to research known issues, recalls, and common failure patterns for the specific vehicle.\n- **Relevant to the Vehicle**: Results are tailored to the exact year, make, model, and engine of the vehicle on the current repair order.\n- **Helpful for Upselling**: Gives service advisors talking points about potential issues the customer should be aware of.\n- **Quick Reference**: Shows common problems at a glance without having to research each vehicle manually.\n\nTo use it, simply open a repair order in Tekmetric and click the **Failures** tab in the MOS extension. The analysis runs automatically for the vehicle on that RO.\n\nRequires the 'common_failures' feature to be enabled.",
    category: "AI Features",
    tags: ["common failures", "ai", "advisor", "vehicle problems", "recalls"]
  },

  // ===== JOB LOOKUP =====
  {
    title: "Using AI-Powered Job Lookup",
    problem: "I need to find specific jobs or services but searching through all available jobs takes too long.",
    solution: "The Job Lookup feature provides intelligent job search with AI scoring:\n\n1. **Open Job Lookup**: Click the **Lookup** tab in the extension while viewing a repair order.\n2. **Search**: Type what you're looking for (e.g., 'brake pads', 'transmission flush', 'alignment').\n3. **AI-Scored Results**: Results are ranked by relevance using AI scoring, so the most relevant jobs appear first.\n4. **Smart Autocomplete**: As you type, suggestions appear to help you find the right job faster.\n5. **Enterprise Search**: If your shop is part of a multi-location enterprise, you can search across all locations' job databases.\n\nThe job lookup uses your shop's canned jobs and maps them intelligently, making it easy to find the right service even if you don't remember the exact job name.",
    category: "AI Features",
    tags: ["job lookup", "search", "ai", "autocomplete", "canned jobs"]
  },

  // ===== INTEGRATIONS =====
  {
    title: "Connecting Tekmetric to MOS",
    problem: "I use Tekmetric for my shop management and want to connect it to MOS.",
    solution: "To connect Tekmetric to MOS:\n\n1. **Navigate to Integrations**: Go to the Integrations page in your MOS dashboard.\n2. **Select Tekmetric**: Choose Tekmetric as your shop management system provider.\n3. **API Credentials**: Enter your Tekmetric API credentials (Client ID and Client Secret). These are provided by Tekmetric.\n4. **Shop Mapping**: Map your Tekmetric shop ID to your MOS shop.\n5. **Webhook Setup**: MOS uses webhooks to stay in sync with Tekmetric. When repair orders are created, updated, or completed in Tekmetric, MOS is automatically notified.\n6. **Chrome Extension**: Install the MOS Chrome extension to access VHI plans, stickers, and other features directly within Tekmetric.\n\n**What syncs automatically:**\n- Repair order status changes\n- Vehicle information\n- Customer data\n- Job and service details\n\nWebhooks ensure your MOS data stays current without manual intervention.",
    category: "Integrations",
    tags: ["tekmetric", "integration", "api", "webhook", "setup", "sync"]
  },
  {
    title: "Connecting Protractor to MOS",
    problem: "My shop uses Protractor and I want to integrate it with MOS.",
    solution: "To connect Protractor to MOS:\n\n1. **Navigate to Integrations**: Go to the Integrations page in your MOS dashboard.\n2. **Select Protractor**: Choose Protractor as your shop management system provider.\n3. **API Setup**: Configure your Protractor API connection with the provided credentials.\n4. **Data Sync**: MOS syncs with Protractor to pull vehicle data, repair orders, and service history.\n5. **Backfill**: Use the Backfill feature in Platform Admin to import historical data from Protractor.\n\n**Protractor-Specific Features:**\n- Deferred work tracking and matching\n- Customer Concern Assistant integration\n- Service history import\n\nThe integration supports incremental sync and rate limiting to avoid overwhelming the Protractor API.",
    category: "Integrations",
    tags: ["protractor", "integration", "api", "setup", "sync", "backfill"]
  },

  // ===== BILLING & SUBSCRIPTION =====
  {
    title: "Understanding VIN-Based Billing",
    problem: "How does billing work? Am I charged per vehicle or per month?",
    solution: "MOS uses a VIN-based billing system:\n\n- **Per-VIN Tracking**: Each unique vehicle (VIN) that you analyze counts toward your usage.\n- **Feature Flags**: Your subscription includes specific features (maintenance plans, job lookup, stickers, etc.) that are enabled for your shop.\n- **Trial Limits**: New shops may have trial limits on the number of VINs they can analyze before choosing a paid plan.\n- **Stripe Integration**: Payments are processed securely through Stripe.\n\n**Grace Period:** If a payment fails, you get a 7-day grace period:\n- Email reminders are sent at days 3-4 and days 1-2 remaining.\n- During the grace period, all features continue to work normally.\n- If the grace period expires without payment, the account transitions to suspended status and features are disabled.\n- Admins can extend grace periods if needed.\n\nContact your administrator for details about your specific plan and pricing.",
    category: "Billing & Subscription",
    tags: ["billing", "vin", "subscription", "stripe", "grace period", "payment"]
  },

  // ===== MULTI-SHOP & ENTERPRISE =====
  {
    title: "Managing Multiple Shop Locations",
    problem: "I have multiple shop locations and need to manage them all from one account.",
    solution: "MOS supports multi-shop and enterprise management:\n\n- **Shop Selector**: Switch between your shops using the shop selector at the top of the dashboard.\n- **Multi-Location Analytics**: View performance metrics across all your locations in one place.\n- **Shared Canned Job Mappings**: Create standard job templates that are shared across all your locations for consistency.\n- **Settings Replication**: Apply settings from one shop to others so you don't have to configure each one individually.\n- **Revenue Attribution**: Track revenue and performance by location.\n- **Enterprise-Wide Job Search**: Search for jobs across all your shop locations.\n\nEach shop can have its own integration setup (Tekmetric or Protractor), its own billing, and its own feature flags. Enterprise users get access to additional analytics and management tools.",
    category: "Enterprise",
    tags: ["multi-shop", "enterprise", "locations", "analytics", "management"]
  },

  // ===== BACKFILL =====
  {
    title: "What is Data Backfill and How Does It Work?",
    problem: "I just connected my shop management system and I don't see historical data. How do I import past data?",
    solution: "Data Backfill imports your historical repair order and vehicle data from your shop management system into MOS:\n\n**For Tekmetric:**\n- Backfill is managed through the Platform Admin panel.\n- It automatically triggers when certain conditions are met (e.g., new shop connection).\n- Progress and completion are tracked in the admin interface.\n- Uses the Tekmetric API with proper rate limiting to avoid disruptions.\n\n**For Protractor:**\n- Also managed through Platform Admin.\n- Imports historical repair orders, vehicle data, and service history.\n- Supports incremental backfill for ongoing sync.\n\n**What gets imported:**\n- Repair order history\n- Vehicle records and VIN data\n- Customer information\n- Service and job details\n- Mileage records\n\nBackfill runs in the background and doesn't affect your day-to-day operations. You'll see historical data appear in the system as the import completes.",
    category: "Data Management",
    tags: ["backfill", "import", "historical data", "tekmetric", "protractor", "sync"]
  },

  // ===== AUTO BOOKING =====
  {
    title: "How Auto Booking Works",
    problem: "I heard MOS can automatically schedule oil change appointments. How does that work?",
    solution: "Auto Booking is a feature-gated system for automated appointment scheduling:\n\n- **Predictive Scheduling**: Based on the customer's driving habits (miles per day), MOS predicts when their next oil change will be due.\n- **Automatic Reminders**: The system can send reminders to customers when their service is approaching.\n- **Appointment Creation**: Helps streamline the booking process by pre-filling vehicle and service information.\n\nAuto Booking requires the 'auto_booking' feature flag to be enabled in your subscription. Contact your administrator to enable this feature.\n\n**Note:** Auto Booking uses the same miles-per-day calculation that powers the smart date prediction on oil stickers, so the suggested service dates are personalized to each customer's actual driving patterns.",
    category: "Auto Booking",
    tags: ["auto booking", "appointment", "scheduling", "reminders", "oil change"]
  },

  // ===== SUPPORT =====
  {
    title: "How to Get Help and Submit Support Tickets",
    problem: "I'm having an issue and need to contact support. How do I get help?",
    solution: "MOS offers multiple ways to get support:\n\n**AI Chat Widget (Dashboard):**\n- Click the chat bubble in the bottom-right corner of any dashboard page.\n- The AI assistant can answer common questions using the knowledge base.\n- If the AI can't resolve your issue, it can create a support ticket for you.\n\n**AI Chat (Chrome Extension):**\n- Use the support chat feature within the MOS Chrome extension.\n- Submit tickets directly from the extension.\n- Tickets can be escalated to the support team.\n\n**Support Tickets:**\n- Tickets are tracked in the system and the support team is notified.\n- You'll receive email updates on your ticket status via the Resend email system.\n- In-app notifications also keep you updated on ticket responses.\n\nWhen submitting a ticket, include as much detail as possible: what you were doing, what you expected to happen, and what actually happened. Screenshots are always helpful!",
    category: "Support",
    tags: ["support", "help", "ticket", "chat", "ai", "escalation"]
  },

  // ===== NOTIFICATIONS =====
  {
    title: "Understanding Notifications and Emails",
    problem: "I'm getting emails and in-app notifications. Where do they come from and how do I manage them?",
    solution: "MOS uses two notification channels:\n\n**Email Notifications (via Resend):**\n- Support ticket updates\n- Billing reminders (grace period warnings)\n- Important account changes\n\n**In-App Notifications:**\n- Appear in the notification bell icon in your dashboard header.\n- Show the count of unread notifications.\n- Include updates about tickets, system changes, and important alerts.\n\nNotifications are designed to keep you informed without being overwhelming. Critical items like billing grace period warnings are sent via both email and in-app notifications to make sure you don't miss them.",
    category: "Notifications",
    tags: ["notifications", "email", "resend", "alerts", "in-app"]
  },

  // ===== DISTANCE UNITS =====
  {
    title: "Switching Between Miles and Kilometers",
    problem: "My shop uses kilometers instead of miles. Can I change the distance units?",
    solution: "Yes! MOS supports both miles and kilometers:\n\n1. Go to **Settings** in your shop dashboard.\n2. Find the **Distance Units** preference.\n3. Select either **Miles** or **Kilometers**.\n4. Save your changes.\n\nOnce changed, all distance-related displays throughout the system will use your preferred unit:\n- Maintenance plan mileage thresholds\n- Oil sticker next-service mileage\n- Vehicle mileage displays\n- Due soon/overdue calculations\n\nThis is a per-shop setting, so each location can have its own preference if needed.",
    category: "Settings",
    tags: ["miles", "kilometers", "distance", "units", "settings", "preferences"]
  },

  // ===== DECLINED SERVICES =====
  {
    title: "Tracking Declined Services",
    problem: "A customer declined a service we recommended. How does MOS track this?",
    solution: "MOS automatically tracks declined services and factors them into future maintenance plans:\n\n- **Automatic Tracking**: When a service is recommended but declined in the repair order, MOS records it.\n- **Plan Integration**: Declined services appear in future Vehicle Health Intelligence plans, often flagged as overdue or due soon since they were previously needed.\n- **History**: The decline is recorded with the date, mileage, and reason (if provided).\n- **Follow-Up**: Service advisors can see at a glance what was previously declined, making it easy to re-recommend the service on the customer's next visit.\n\nThis creates a complete picture of the vehicle's maintenance needs and helps ensure nothing falls through the cracks between visits.",
    category: "Vehicle Health Intelligence",
    tags: ["declined", "services", "tracking", "follow-up", "history"]
  },

  // ===== BACKGROUND PREFETCH =====
  {
    title: "How Background Plan Prefetching Works",
    problem: "Plans seem to load faster after I've been using the extension for a while. Why is that?",
    solution: "MOS uses intelligent background prefetching to speed up your workflow:\n\n- **Trigger**: When you view a Vehicle Health Intelligence plan for one repair order, the extension signals the server.\n- **Background Work**: The server then looks at other open repair orders at the same shop and pre-generates their plans in the background.\n- **Rate Limited**: Up to 15 ROs are prefetched at a time, with rate limiting per shop to avoid overloading the system.\n- **DB Lock**: A database lock prevents multiple prefetch jobs from running simultaneously for the same shop.\n- **Result**: When you navigate to another RO, its plan is already cached and loads instantly.\n\nThis happens completely in the background and doesn't affect the performance of the plan you're currently viewing. It's designed to make your workflow smoother throughout the day.",
    category: "Performance",
    tags: ["prefetch", "background", "performance", "cache", "speed"]
  },

  // ===== AI SUPPORT CHATBOT =====
  {
    title: "Using the AI Support Chat",
    problem: "I see a chat bubble on the dashboard and in the Chrome extension. How does the AI support chat work?",
    solution: "MOS includes an AI-powered support chatbot available in two places:\n\n**Dashboard Chat Widget:**\n- Click the chat bubble in the bottom-right corner of any dashboard page.\n- Ask questions about features, troubleshoot issues, or get help with the system.\n- The AI searches the knowledge base for relevant answers.\n- If the AI can't resolve your issue, it can escalate to a support ticket.\n\n**Chrome Extension Chat:**\n- Access AI support directly within the MOS Chrome extension.\n- Submit support tickets without leaving Tekmetric.\n- Tickets include context about what you were working on.\n- Escalation routes your issue to the support team with full conversation history.\n\n**How it works:**\n- The chatbot uses OpenAI to understand your question.\n- It first searches the knowledge base for matching articles.\n- If a match is found, it provides the answer directly.\n- If not, it uses AI to generate a helpful response.\n- You can always escalate to human support if the AI response isn't sufficient.",
    category: "Support",
    tags: ["ai chat", "chatbot", "support", "widget", "extension", "escalation", "openai"]
  },

  // ===== ADMIN & MONITORING =====
  {
    title: "Platform Admin: Audit Logging and Monitoring",
    problem: "How can I see what actions have been taken in the system and monitor API usage?",
    solution: "MOS provides comprehensive admin monitoring tools (available to platform administrators):\n\n**Audit Logging:**\n- All significant actions in the system are logged with timestamps, user information, and details.\n- View audit trails to understand who did what and when.\n- Useful for troubleshooting issues and maintaining accountability.\n\n**API Usage Monitoring:**\n- A unified dashboard shows API usage across all integrated providers (Tekmetric, Protractor, OpenAI, etc.).\n- Track request volumes, response times, and error rates.\n- Identify potential issues before they affect users.\n\n**Platform Observability:**\n- Access the observability page at the Platform Admin section of the dashboard.\n- View streamed logs from your deployments with filtering capabilities.\n- Filter logs by level (error, warning, info), time range, and content.\n- API usage analytics help identify trends and optimize costs.\n- Log data is retained for 30 days.\n\nThese tools are only available to users with the 'platform_admin' role.",
    category: "Admin & Monitoring",
    tags: ["admin", "audit", "logging", "monitoring", "api usage", "observability", "platform admin"]
  },

  // ===== DVI INTEGRATIONS =====
  {
    title: "Digital Vehicle Inspections (DVI) Integration",
    problem: "How does MOS use inspection data from AutoFlow or AutoVitals?",
    solution: "MOS integrates with Digital Vehicle Inspection (DVI) platforms to enhance maintenance plans:\n\n**Supported DVI Providers:**\n- **AutoFlow**: Inspection findings are pulled into VHI plans.\n- **AutoVitals**: Inspection data is similarly integrated.\n\n**How DVI Data is Used:**\n- Inspection findings are factored into the Vehicle Health Intelligence plan.\n- Items flagged during an inspection appear in the appropriate priority bucket (Overdue, Due Soon, or Upcoming).\n- The data source is indicated with a visual badge so you can see where each recommendation came from (OEM schedule, DVI finding, or shop management system).\n- DVI-sourced items help create a more complete picture of the vehicle's condition beyond just mileage-based intervals.\n\n**Data Source Badges:**\nEach item in a VHI plan shows where the recommendation originated:\n- **OEM**: From the manufacturer's recommended schedule.\n- **DVI**: From a digital vehicle inspection (AutoFlow or AutoVitals).\n- **Protractor**: From Protractor deferred work items.\n\nThis multi-source approach ensures nothing is missed in the maintenance plan.",
    category: "Integrations",
    tags: ["dvi", "autoflow", "autovitals", "inspection", "digital", "vehicle inspection"]
  },

  // ===== PART CROSS-REFERENCE =====
  {
    title: "Using Part Cross-Reference",
    problem: "What is the Part Cross-Reference feature and how do I use it?",
    solution: "Part Cross-Reference is a modular feature that helps you find equivalent parts across different manufacturers and suppliers:\n\n- **Cross-Reference Lookup**: Enter a part number from one manufacturer and find equivalent parts from other brands.\n- **Time Saver**: Quickly find alternative parts without manually searching multiple catalogs.\n- **Availability**: Helps when a specific part is out of stock by showing compatible alternatives.\n\nPart Cross-Reference requires the 'part_xref' feature flag to be enabled in your subscription. Access it through the extension or dashboard depending on your setup.\n\nThis feature is especially useful for shops that work with multiple parts suppliers and need to quickly compare options.",
    category: "Parts",
    tags: ["part", "cross-reference", "xref", "lookup", "parts", "alternative"]
  },

  // ===== FEATURE FLAGS =====
  {
    title: "Understanding Feature Flags and Your Subscription",
    problem: "What are feature flags and how do they control what I can access?",
    solution: "MOS uses a modular feature flag system that controls which capabilities are available to your shop:\n\n**Available Feature Flags:**\n- **maintenance**: Vehicle Health Intelligence plans and maintenance recommendations.\n- **job_lookup**: AI-powered job search with smart autocomplete.\n- **common_failures**: AI common failures advisor for specific vehicles.\n- **oil_sticker**: Oil change sticker design and printing.\n- **keytags**: Keytag label design and printing.\n- **auto_booking**: Automated appointment scheduling.\n- **part_xref**: Part cross-reference lookup.\n- **labor_rates**: Labor rate rules with automatic application.\n- **concern_assistant**: Customer Concern Assistant for intake.\n\n**How They Work:**\n- Each shop has a set of enabled features based on their subscription.\n- In the Chrome extension, tabs for unsubscribed features show an upgrade overlay with a lock icon.\n- Features can be added individually (a la carte) — you only pay for what you need.\n- Feature changes take effect immediately.\n\nTo change your subscribed features, contact your MOS administrator or check the billing settings in your dashboard.",
    category: "Settings",
    tags: ["feature flags", "subscription", "modular", "features", "a la carte", "settings"]
  },

  // ===== WEBHOOKS =====
  {
    title: "How Webhooks Keep Your Data Fresh",
    problem: "How does MOS stay in sync with my shop management system without me doing anything?",
    solution: "MOS uses webhooks to automatically stay synchronized with your shop management system:\n\n**What Are Webhooks?**\nWebhooks are automatic notifications sent from your shop management system (like Tekmetric) to MOS whenever something changes.\n\n**What Triggers a Webhook:**\n- Repair order created or updated\n- Repair order status changed (e.g., moved to 'Work In Progress')\n- Jobs added or modified on a repair order\n- Repair order completed or posted\n\n**What Happens When a Webhook is Received:**\n1. MOS updates the repair order data in its database.\n2. The cached Vehicle Health Intelligence plan for that vehicle is invalidated.\n3. The next time anyone views that vehicle's plan, a completely fresh analysis runs.\n\n**Benefits:**\n- No manual syncing required.\n- Plans always reflect the latest repair order changes.\n- Status updates appear automatically.\n- Works in the background without any user action.\n\nWebhooks are configured automatically when you connect your shop management system through the Integrations page.",
    category: "Data Management",
    tags: ["webhook", "sync", "automatic", "real-time", "tekmetric", "data freshness"]
  },

  // ===== ROLES & ACCESS =====
  {
    title: "User Roles and Access Control",
    problem: "What are the different user roles and what can each role do?",
    solution: "MOS uses role-based access control to manage what each user can see and do:\n\n**User Roles:**\n- **Shop User**: Standard access to shop features, vehicle plans, stickers, and the Chrome extension. Can only access shops they're assigned to.\n- **Shop Owner**: Full access to their shop(s) including settings, billing, and user management.\n- **Platform Admin**: System-wide access including all shops, admin tools, observability, backfill management, and system configuration.\n\n**Security Features:**\n- Passwords are securely hashed using bcrypt.\n- Token-based authentication for API access.\n- The Chrome extension uses its own authentication tokens.\n- Each API request is verified against the user's role and shop assignments.\n\n**Multi-Shop Access:**\nUsers can be assigned to multiple shops. When using the Chrome extension, shop access is verified against both the user's shop assignments and the Tekmetric/Protractor shop mapping.",
    category: "Settings",
    tags: ["roles", "access", "permissions", "admin", "owner", "security", "authentication"]
  },

  // ===== WORK ORDER CREATION =====
  {
    title: "Creating Work Orders from the Dashboard",
    problem: "How do I create a new work order (repair order) directly from the MOS dashboard instead of going into Protractor?",
    solution: "MOS provides a multi-step wizard for creating Protractor work orders right from your dashboard:\n\n1. **Click 'New RO'**: The green button at the top of your dashboard opens the work order creation wizard.\n2. **Customer Concern** (optional): Enter the customer's concern, or use the AI-powered Customer Concern Assistant to build a professional write-up with follow-up questions.\n3. **Select Customer**: Search for the customer by name. Their vehicles are loaded automatically.\n4. **Select Vehicle**: Choose the vehicle from the customer's list. You'll see year, make, model, VIN, and last known odometer.\n5. **Current Mileage** (optional): Enter the current odometer reading if known. If left blank, the dashboard will show the mileage as blank until CARFAX estimation fills it in.\n6. **Add Note** (optional): Add any internal notes for the work order.\n7. **Add Jobs**: Search and add services from three sources:\n   - **Canned Jobs**: Your shop's pre-configured service templates.\n   - **Deferred Work**: Previously declined services for this vehicle.\n   - **Job History**: AI-scored search across your shop's service history with match quality indicators.\n8. **Create**: The work order is created in Protractor with all selected jobs, complete with parts and labor pricing.\n\n**Important:** Jobs are added with full pricing details (labor rates, part costs, quantities) — they show up in Protractor exactly as they would if added through the VHI system.",
    category: "Work Order Creation",
    tags: ["work order", "repair order", "create", "new ro", "protractor", "wizard", "dashboard"]
  },
  {
    title: "Adding Jobs to a New Work Order",
    problem: "I'm creating a new work order and want to add specific services. How do the job tabs work?",
    solution: "When creating a work order, the 'Add Jobs' step has three tabs for finding and adding services:\n\n**Canned Jobs Tab:**\n- Search your shop's pre-configured service packages by name.\n- These are the standard services your shop offers.\n- Each result shows the job name and number of line items (parts + labor).\n\n**Deferred Work Tab:**\n- Automatically loads previously declined services for the selected vehicle.\n- Shows the original job title, when it was deferred, and line item count.\n- Great for following up on services the customer previously declined.\n\n**Job History Tab:**\n- Searches across your shop's complete service history using AI-scored matching.\n- Results show match quality badges (Exact Fit, Great Match, Good Match).\n- Finds jobs performed on similar vehicles (same make/model/engine) — not just the exact vehicle.\n- For multi-location shops, searches across all enterprise locations.\n- Shows which location performed the job if it's from another shop.\n\n**Each job you add shows:**\n- A source badge (Canned, Deferred, or History)\n- The job title\n- Number of line items\n\nYou can add multiple jobs from any combination of tabs before creating the work order.",
    category: "Work Order Creation",
    tags: ["jobs", "canned jobs", "deferred work", "job history", "add jobs", "work order", "ai scoring"]
  },
  {
    title: "Why Work Order Jobs Show Full Pricing in Protractor",
    problem: "When I create a work order from MOS, do the jobs show up with correct pricing in Protractor?",
    solution: "Yes! MOS uses a two-phase approach to ensure jobs show up with full, correct pricing in Protractor:\n\n**How it works:**\n1. MOS first creates the work order with just the customer concern (if provided).\n2. Then it adds each service package individually, fetching the work order and appending to it.\n3. This matches the same proven pattern used by the Vehicle Health Intelligence (VHI) system.\n\n**Pricing details included:**\n- **Labor lines**: Include labor rate, technician hours, and calculated totals.\n- **Parts/Material lines**: Include unit price, quantity, part numbers, manufacturers, and calculated totals.\n- All prices use string-typed values matching Protractor's expected format.\n\n**Labor rate resolution:**\n- Uses your shop's cached labor rate first.\n- Falls back to rates from existing work order lines.\n- Then falls back to the job's own rate.\n\nThis ensures that every job added through MOS appears in Protractor with the same pricing detail as if it were added manually or through the VHI extension.",
    category: "Work Order Creation",
    tags: ["pricing", "labor rate", "parts", "protractor", "work order", "two-phase", "vhi"]
  },

  // ===== MILEAGE HANDLING =====
  {
    title: "Dashboard Mileage: Entered vs Estimated",
    problem: "Sometimes the mileage column on my dashboard shows a number in regular text, and sometimes in italic with '(est.)'. What's the difference?",
    solution: "The dashboard mileage column shows two types of readings:\n\n**Regular text (e.g., '145,268'):**\n- This is the actual odometer reading entered on the work order (the 'mileage in' field).\n- It was explicitly recorded by a service advisor when the vehicle came in.\n\n**Bold italic with '(est.)' (e.g., '115,763 (est.)'):**\n- This is a CARFAX-estimated mileage.\n- It appears when no odometer reading was entered on the work order.\n- Hover over it to see details about how the estimate was calculated.\n\n**How it works:**\n- When you create a work order without entering mileage, the dashboard shows the mileage field as blank initially.\n- The system then checks CARFAX history for that vehicle and calculates an estimate based on the vehicle's driving patterns.\n- The estimate shows up in italic so you can always tell it apart from an actual reading.\n\n**Why not use the vehicle's old mileage?**\nMOS intentionally does NOT fall back to the vehicle's previously stored odometer reading. This prevents stale/old mileage from being displayed as if it were current. The CARFAX estimate is more accurate because it accounts for how much the customer has driven since their last service.",
    category: "Vehicle Health Intelligence",
    tags: ["mileage", "odometer", "estimated", "carfax", "dashboard", "italic", "inusage"]
  }
];

async function seedKnowledgeBase() {
  console.log("Connecting to MongoDB...");
  const db = await getDb();
  
  const existing = await db.collection("knowledge_articles").countDocuments();
  console.log(`Found ${existing} existing articles`);
  
  let created = 0;
  let skipped = 0;
  
  for (const article of articles) {
    const exists = await db.collection("knowledge_articles").findOne({ title: article.title });
    if (exists) {
      console.log(`  SKIP: "${article.title}" (already exists)`);
      skipped++;
      continue;
    }
    
    const now = new Date();
    await db.collection("knowledge_articles").insertOne({
      ...article,
      createdBy: "system",
      createdAt: now,
      updatedAt: now,
      viewCount: 0,
      helpfulCount: 0
    });
    console.log(`  CREATED: "${article.title}" [${article.category}]`);
    created++;
  }
  
  console.log(`\nDone! Created ${created} articles, skipped ${skipped} existing.`);
  console.log(`Total articles now: ${existing + created}`);
  process.exit(0);
}

seedKnowledgeBase().catch(err => {
  console.error("Failed to seed knowledge base:", err);
  process.exit(1);
});
