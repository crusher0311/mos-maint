"use client";

import { useState, useEffect } from "react";
import { 
  Search, 
  BookOpen, 
  Puzzle, 
  Printer, 
  Car, 
  Settings, 
  Users, 
  CreditCard,
  HelpCircle,
  ChevronRight,
  ExternalLink,
  FileText,
  Zap,
  Chrome,
  Loader2
} from "lucide-react";

interface Guide {
  id: string;
  title: string;
  description: string;
  category: string;
  icon: React.ReactNode;
  steps?: string[];
}

const guides: Guide[] = [
  {
    id: "getting-started",
    title: "Getting Started",
    description: "Learn the basics of MOS Maintenance and set up your shop",
    category: "basics",
    icon: <Zap className="w-5 h-5" />,
    steps: [
      "Log in to your MOS Maintenance account",
      "Complete your shop profile in Settings",
      "Connect your shop management system (Tekmetric, Protractor, etc.)",
      "Wait for your vehicles to sync automatically",
      "Start looking up vehicles and printing stickers!"
    ]
  },
  {
    id: "connect-integration",
    title: "Connecting Integrations",
    description: "How to link your shop management system for automatic data sync",
    category: "integrations",
    icon: <Puzzle className="w-5 h-5" />,
    steps: [
      "Go to Settings > Integrations",
      "Select your shop management system",
      "Enter your API credentials or authorize via OAuth",
      "Click 'Connect' and wait for the initial sync",
      "Your vehicles will appear on the dashboard within minutes"
    ]
  },
  {
    id: "print-sticker",
    title: "Printing Oil Change Stickers",
    description: "Generate and print professional oil change reminder stickers",
    category: "printing",
    icon: <Printer className="w-5 h-5" />,
    steps: [
      "Search for a vehicle using VIN, plate, or customer name",
      "Click on the vehicle to open its detail page",
      "Review the vehicle information and service details",
      "Click 'Print Sticker' to open the sticker preview",
      "Customize if needed, then print or download"
    ]
  },
  {
    id: "keytag-printing",
    title: "Printing Keytags",
    description: "Create and print vehicle keytags on Dymo label printers",
    category: "printing",
    icon: <Printer className="w-5 h-5" />,
    steps: [
      "Go to Settings > Keytags to customize your keytag design",
      "Use the visual designer to arrange elements",
      "Save your design",
      "When viewing a vehicle, click 'Print Keytag'",
      "The keytag will print on your connected Dymo printer"
    ]
  },
  {
    id: "vehicle-lookup",
    title: "Looking Up Vehicles",
    description: "Find vehicles quickly using various search methods",
    category: "vehicles",
    icon: <Car className="w-5 h-5" />,
    steps: [
      "Use the search bar on the dashboard",
      "Enter a VIN, license plate, or customer name",
      "Click on a result to view full vehicle details",
      "Access maintenance history, recommendations, and printing options"
    ]
  },
  {
    id: "chrome-extension",
    title: "Using the Chrome Extension",
    description: "Access MOS features directly from your shop management system",
    category: "advanced",
    icon: <Chrome className="w-5 h-5" />,
    steps: [
      "Install the MOS Maintenance Chrome extension",
      "Log in with your MOS account credentials",
      "Navigate to a vehicle in Tekmetric or your SMS",
      "The extension sidebar will show maintenance recommendations",
      "Print stickers and keytags directly from the extension"
    ]
  },
  {
    id: "manage-users",
    title: "Managing Team Members",
    description: "Add and manage users who can access your shop account",
    category: "settings",
    icon: <Users className="w-5 h-5" />,
    steps: [
      "Go to Settings > Users",
      "Click 'Invite User'",
      "Enter their email address and select a role",
      "They'll receive an email invitation to join",
      "Manage permissions and remove users as needed"
    ]
  },
  {
    id: "billing",
    title: "Understanding Billing",
    description: "Learn about VIN-based billing and managing your subscription",
    category: "billing",
    icon: <CreditCard className="w-5 h-5" />,
    steps: [
      "Your subscription includes 300 VINs per month",
      "A VIN is counted when you print a sticker or access its data",
      "View your usage in Settings > Billing",
      "Additional VINs are billed at $0.50 each",
      "Upgrade to a higher tier for more included VINs"
    ]
  }
];

const faqs = [
  {
    question: "How do I reset my password?",
    answer: "Click 'Forgot Password' on the login page, enter your email, and follow the reset instructions sent to your inbox."
  },
  {
    question: "Why aren't my vehicles syncing?",
    answer: "Check that your integration is connected in Settings > Integrations. If it shows as connected, try clicking 'Sync Now'. Syncs typically run every hour automatically."
  },
  {
    question: "Can I customize my sticker design?",
    answer: "Yes! Go to Settings > Stickers to customize colors, logo placement, and which information appears on your stickers."
  },
  {
    question: "What shop management systems do you support?",
    answer: "We currently support Tekmetric, Protractor, AutoFlow, Shopware, and Shopmonkey. More integrations are added regularly."
  },
  {
    question: "How do I print keytags?",
    answer: "You'll need a Dymo LabelWriter printer. Go to Settings > Keytags to design your keytag, then use the 'Print Keytag' button on any vehicle page."
  },
  {
    question: "What does the AI recommendation feature do?",
    answer: "Our AI analyzes each vehicle's service history, OEM maintenance schedules, and common failure patterns to suggest what services are likely needed."
  }
];

export default function HelpPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedGuide, setSelectedGuide] = useState<Guide | null>(null);
  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);

  const filteredGuides = guides.filter(guide => {
    const matchesSearch = searchQuery === "" || 
      guide.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      guide.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCategory = selectedCategory === null || guide.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const categories = [
    { id: "basics", name: "Getting Started", icon: BookOpen },
    { id: "integrations", name: "Integrations", icon: Puzzle },
    { id: "printing", name: "Printing", icon: Printer },
    { id: "vehicles", name: "Vehicles", icon: Car },
    { id: "settings", name: "Settings", icon: Settings },
    { id: "advanced", name: "Advanced", icon: Zap }
  ];

  if (selectedGuide) {
    return (
      <div className="flex-1 p-8 overflow-auto">
        <div className="max-w-3xl mx-auto">
          <button
            onClick={() => setSelectedGuide(null)}
            className="text-blue-600 hover:text-blue-700 mb-6 flex items-center gap-1"
          >
            <ChevronRight className="w-4 h-4 rotate-180" />
            Back to Help Center
          </button>

          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8">
            <div className="flex items-start gap-4 mb-6">
              <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center text-blue-600">
                {selectedGuide.icon}
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">{selectedGuide.title}</h1>
                <p className="text-gray-500 mt-1">{selectedGuide.description}</p>
              </div>
            </div>

            {selectedGuide.steps && (
              <div className="space-y-4">
                <h2 className="font-semibold text-gray-900">Step-by-step instructions:</h2>
                <ol className="space-y-3">
                  {selectedGuide.steps.map((step, index) => (
                    <li key={index} className="flex items-start gap-3">
                      <span className="flex-shrink-0 w-6 h-6 bg-blue-600 text-white rounded-full flex items-center justify-center text-sm font-medium">
                        {index + 1}
                      </span>
                      <span className="text-gray-700 pt-0.5">{step}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-8 overflow-auto">
      <div className="max-w-5xl mx-auto space-y-8">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-100 rounded-2xl mb-4">
            <HelpCircle className="w-8 h-8 text-blue-600" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900">How can we help?</h1>
          <p className="text-gray-500 mt-2">Find guides, tutorials, and answers to common questions</p>
        </div>

        <div className="relative max-w-xl mx-auto">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
          <input
            type="text"
            placeholder="Search for help..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-12 pr-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {categories.map((category) => (
            <button
              key={category.id}
              onClick={() => setSelectedCategory(selectedCategory === category.id ? null : category.id)}
              className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${
                selectedCategory === category.id 
                  ? "bg-blue-50 border-blue-300 ring-2 ring-blue-200" 
                  : "bg-white border-gray-200 hover:border-blue-200 hover:bg-blue-50"
              }`}
            >
              <category.icon className={`w-6 h-6 ${selectedCategory === category.id ? "text-blue-700" : "text-blue-600"}`} />
              <span className={`text-sm font-medium ${selectedCategory === category.id ? "text-blue-700" : "text-gray-700"}`}>{category.name}</span>
            </button>
          ))}
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-600" />
            Guides & Tutorials
          </h2>
          <div className="grid md:grid-cols-2 gap-4">
            {filteredGuides.map((guide) => (
              <button
                key={guide.id}
                onClick={() => setSelectedGuide(guide)}
                className="flex items-start gap-4 p-4 rounded-xl border border-gray-200 hover:border-blue-200 hover:bg-blue-50/50 transition-all text-left group"
              >
                <div className="flex-shrink-0 w-10 h-10 bg-gray-100 group-hover:bg-blue-100 rounded-lg flex items-center justify-center text-gray-600 group-hover:text-blue-600 transition-colors">
                  {guide.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                    {guide.title}
                  </h3>
                  <p className="text-sm text-gray-500 mt-0.5 line-clamp-2">{guide.description}</p>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-blue-500 transition-colors flex-shrink-0 mt-2" />
              </button>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <HelpCircle className="w-5 h-5 text-blue-600" />
            Frequently Asked Questions
          </h2>
          <div className="space-y-2">
            {faqs.map((faq, index) => (
              <div
                key={index}
                className="border border-gray-200 rounded-lg overflow-hidden"
              >
                <button
                  onClick={() => setExpandedFaq(expandedFaq === index ? null : index)}
                  className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50 transition-colors"
                >
                  <span className="font-medium text-gray-900">{faq.question}</span>
                  <ChevronRight className={`w-5 h-5 text-gray-400 transition-transform ${
                    expandedFaq === index ? "rotate-90" : ""
                  }`} />
                </button>
                {expandedFaq === index && (
                  <div className="px-4 pb-4 text-gray-600">
                    {faq.answer}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="bg-blue-50 rounded-xl p-6 border border-blue-100 text-center">
          <h3 className="font-semibold text-blue-900 mb-2">Still need help?</h3>
          <p className="text-sm text-blue-800 mb-4">
            Our support team is ready to assist you with any questions.
          </p>
          <a
            href="/dashboard/support"
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
          >
            Contact Support
            <ExternalLink className="w-4 h-4" />
          </a>
        </div>
      </div>
    </div>
  );
}
