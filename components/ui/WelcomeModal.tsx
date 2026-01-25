"use client";

import { useState, useEffect } from "react";
import { X, Rocket, BookOpen, Puzzle, Printer, HelpCircle, ArrowRight, CheckCircle } from "lucide-react";

interface WelcomeModalProps {
  shopName?: string;
  onClose: () => void;
  onStartTour?: () => void;
}

const quickStartItems = [
  {
    icon: Puzzle,
    title: "Connect Your Shop System",
    description: "Link Tekmetric, Protractor, or other systems to sync your vehicles",
    href: "/dashboard/settings/integrations",
    color: "blue"
  },
  {
    icon: Printer,
    title: "Print Your First Sticker",
    description: "Look up a vehicle and generate an oil change sticker",
    href: "/dashboard",
    color: "green"
  },
  {
    icon: BookOpen,
    title: "Explore the Help Center",
    description: "Find guides, tutorials, and answers to common questions",
    href: "/dashboard/help",
    color: "purple"
  }
];

export function WelcomeModal({ shopName, onClose, onStartTour }: WelcomeModalProps) {
  const [step, setStep] = useState(0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden">
        {step === 0 && (
          <>
            <div className="bg-gradient-to-br from-blue-600 to-blue-700 px-8 py-10 text-white text-center relative">
              <button
                onClick={onClose}
                className="absolute top-4 right-4 p-2 hover:bg-white/20 rounded-lg transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
              <div className="inline-flex items-center justify-center w-16 h-16 bg-white/20 rounded-2xl mb-4">
                <Rocket className="w-8 h-8" />
              </div>
              <h2 className="text-2xl font-bold mb-2">Welcome to MOS Maintenance!</h2>
              <p className="text-blue-100">
                {shopName ? `Great to have ${shopName} on board.` : "Let's get your shop set up."} 
                {" "}Here's how to get started.
              </p>
            </div>
            <div className="p-6 space-y-4">
              {quickStartItems.map((item, index) => (
                <a
                  key={index}
                  href={item.href}
                  onClick={onClose}
                  className="flex items-start gap-4 p-4 rounded-xl border border-gray-200 hover:border-blue-200 hover:bg-blue-50/50 transition-all group"
                >
                  <div className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${
                    item.color === "blue" ? "bg-blue-100 text-blue-600" :
                    item.color === "green" ? "bg-green-100 text-green-600" :
                    "bg-purple-100 text-purple-600"
                  }`}>
                    <item.icon className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-gray-900 group-hover:text-blue-600 transition-colors">
                      {item.title}
                    </h3>
                    <p className="text-sm text-gray-500 mt-0.5">{item.description}</p>
                  </div>
                  <ArrowRight className="w-5 h-5 text-gray-400 group-hover:text-blue-500 transition-colors flex-shrink-0 mt-2" />
                </a>
              ))}
            </div>
            <div className="px-6 pb-6 flex items-center justify-between">
              <button
                onClick={() => setStep(1)}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Take a quick tour
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                Get Started
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <TourStep onClose={onClose} onBack={() => setStep(0)} />
        )}
      </div>
    </div>
  );
}

function TourStep({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const [currentTip, setCurrentTip] = useState(0);
  
  const tips = [
    {
      title: "Dashboard Overview",
      description: "Your dashboard shows all vehicles with recent activity. Use the search bar to quickly find any vehicle by VIN, plate, or customer name.",
      icon: "dashboard"
    },
    {
      title: "Quick Sticker Printing",
      description: "Click on any vehicle to open its details, then use the 'Print Sticker' button to generate an oil change reminder sticker with QR code.",
      icon: "print"
    },
    {
      title: "Maintenance Recommendations",
      description: "Our AI analyzes each vehicle's history and OEM schedules to suggest what services are due. Look for the recommendations tab on vehicle pages.",
      icon: "ai"
    },
    {
      title: "Settings & Customization",
      description: "Visit Settings to customize your stickers, connect integrations, manage team members, and configure your shop preferences.",
      icon: "settings"
    }
  ];

  const tip = tips[currentTip];

  return (
    <>
      <div className="px-8 py-10 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-100 rounded-2xl mb-4">
          <HelpCircle className="w-8 h-8 text-blue-600" />
        </div>
        <h2 className="text-xl font-bold text-gray-900 mb-2">{tip.title}</h2>
        <p className="text-gray-600">{tip.description}</p>
        
        <div className="flex items-center justify-center gap-2 mt-6">
          {tips.map((_, index) => (
            <button
              key={index}
              onClick={() => setCurrentTip(index)}
              className={`w-2 h-2 rounded-full transition-colors ${
                index === currentTip ? "bg-blue-600" : "bg-gray-300"
              }`}
            />
          ))}
        </div>
      </div>
      <div className="px-6 pb-6 flex items-center justify-between border-t border-gray-100 pt-4">
        <button
          onClick={onBack}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Back
        </button>
        <div className="flex items-center gap-3">
          {currentTip > 0 && (
            <button
              onClick={() => setCurrentTip(currentTip - 1)}
              className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              Previous
            </button>
          )}
          {currentTip < tips.length - 1 ? (
            <button
              onClick={() => setCurrentTip(currentTip + 1)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              Next
            </button>
          ) : (
            <button
              onClick={onClose}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium flex items-center gap-2"
            >
              <CheckCircle className="w-4 h-4" />
              Done
            </button>
          )}
        </div>
      </div>
    </>
  );
}
