"use client";

import { useState, useEffect } from "react";
import { Clock, CheckCircle, ArrowRight, Calendar, Quote, ChevronLeft, ChevronRight, Check, X, ShoppingCart } from "lucide-react";
import Link from "next/link";

const screenshots = [
  { src: "/screenshots/dashboard.png", alt: "Vehicle Dashboard", caption: "See all active vehicles at a glance" },
  { src: "/screenshots/maintenance-plan.png", alt: "Maintenance Plan", caption: "AI-powered maintenance recommendations with history" },
  { src: "/screenshots/job-history.png", alt: "Job History Lookup", caption: "Find past jobs with parts and pricing instantly" },
  { src: "/screenshots/oem-data.png", alt: "OEM Data", caption: "Complete OEM maintenance schedules by system" },
  { src: "/screenshots/carfax-history.png", alt: "CARFAX History", caption: "Full CARFAX service history integration" },
];

const chromeExtScreenshots = [
  { src: "/screenshots/chrome-ext-plan.png", alt: "Chrome Extension - Maintenance Plan", caption: "Maintenance plans right inside Tekmetric" },
  { src: "/screenshots/chrome-ext-job.png", alt: "Chrome Extension - Job Lookup", caption: "Search job history without leaving the RO" },
];

const plans = [
  {
    name: "Starter",
    slug: "starter",
    price: "$199.95",
    description: "Essential tools for smaller shops",
    vins: "200 VINs/month",
    features: {
      maintenance: true,
      job_lookup: true,
      common_failures: false,
      oil_sticker: true,
      keytags: false,
      auto_booking: false,
      part_xref: false,
    },
    cta: "Start with Starter",
    popular: false,
  },
  {
    name: "Plus",
    slug: "plus",
    price: "$229.95",
    description: "Best value for growing shops",
    vins: "300 VINs/month",
    features: {
      maintenance: true,
      job_lookup: true,
      common_failures: true,
      oil_sticker: true,
      keytags: true,
      auto_booking: false,
      part_xref: true,
    },
    cta: "Start with Plus",
    popular: true,
  },
  {
    name: "Elite",
    slug: "elite",
    price: "$279.95",
    description: "Full power for high-volume shops",
    vins: "500 VINs/month",
    features: {
      maintenance: true,
      job_lookup: true,
      common_failures: true,
      oil_sticker: true,
      keytags: true,
      auto_booking: true,
      part_xref: true,
    },
    cta: "Start with Elite",
    popular: false,
  },
];

const featureLabels: Record<string, { name: string; description: string }> = {
  maintenance: { name: "Maintenance Recommendations", description: "AI-powered recommendations from OEM data & service history" },
  job_lookup: { name: "Job Lookup / History", description: "Search historical jobs with parts, labor, and pricing" },
  common_failures: { name: "Common Failures Advisor", description: "Predict repairs using your shop's own data" },
  oil_sticker: { name: "Oil Sticker Platform", description: "Generate & print oil change reminder stickers" },
  keytags: { name: "Keytags", description: "Print customer/vehicle info on Dymo labels" },
  auto_booking: { name: "Auto Booking", description: "Automated appointment scheduling from stickers" },
  part_xref: { name: "Part Cross-Reference", description: "Cross-reference parts across manufacturers" },
};

const addOnFeatures = [
  { slug: "common_failures", name: "Common Failures Advisor", price: "$19.95/mo", description: "Predict common repairs by vehicle, powertrain, and mileage using your shop's data" },
  { slug: "keytags", name: "Keytags", price: "$9.95/mo", description: "Print customer and vehicle info on Dymo labels for key identification" },
  { slug: "auto_booking", name: "Auto Booking", price: "$29.95/mo", description: "Automated oil change appointment scheduling from QR stickers" },
  { slug: "part_xref", name: "Part Cross-Reference", price: "$14.95/mo", description: "Cross-reference parts across different manufacturers" },
];

export default function LandingPage() {
  const [isVisible, setIsVisible] = useState(false);
  const [currentSlide, setCurrentSlide] = useState(0);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  const nextSlide = () => setCurrentSlide((prev) => (prev + 1) % screenshots.length);
  const prevSlide = () => setCurrentSlide((prev) => (prev - 1 + screenshots.length) % screenshots.length);

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="bg-white border-b border-gray-100 sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-3 sm:py-4">
            <div className="flex items-center gap-2 sm:gap-3">
              <img src="/icon.png" alt="MOS.Tools" className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg sm:rounded-xl" />
              <span className="text-lg sm:text-xl font-bold text-gray-900">MOS.Tools</span>
            </div>
            <div className="flex items-center gap-2 sm:gap-4">
              <Link href="/login" className="hidden sm:block px-4 py-2 text-gray-600 hover:text-gray-900 font-medium transition-colors">
                Sign In
              </Link>
              <Link href="/setup" className="px-3 py-2 sm:px-5 sm:py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium text-sm sm:text-base">
                Get Started
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative">
        <div className="absolute inset-0 bg-gradient-to-b from-blue-50 to-white"></div>
        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-10 pb-14 sm:pt-16 sm:pb-20">
          <div className={`text-center transition-all duration-700 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold text-gray-900 leading-tight mb-3 sm:mb-4">
              Maintenance Intelligence<br />
              <span className="text-blue-600">For Your Shop</span>
            </h1>
            <p className="text-xs sm:text-sm text-blue-600 font-medium mb-2">Works with Protractor, Tekmetric, AutoFlow & more</p>
            
            <p className="text-lg sm:text-xl md:text-2xl text-gray-600 mb-6 sm:mb-8 max-w-2xl mx-auto px-2">
              Stop digging. Start knowing what cars need — instantly.
            </p>

            <Link 
              href="/setup" 
              className="inline-flex items-center gap-2 px-6 py-3 sm:px-8 sm:py-4 bg-blue-600 text-white rounded-xl text-base sm:text-lg font-semibold hover:bg-blue-700 transition-colors shadow-lg shadow-blue-600/25"
            >
              Choose Your Plan
              <ArrowRight className="w-4 h-4 sm:w-5 sm:h-5" />
            </Link>
            <p className="text-xs sm:text-sm text-gray-500 mt-3">Plans starting at $199.95/month</p>
          </div>
        </div>
      </section>

      {/* Integrations Bar */}
      <section className="py-6 sm:py-8 bg-white border-y border-gray-100">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <p className="text-center text-xs sm:text-sm text-gray-500 mb-4 sm:mb-6">Works with the tools you already use</p>
          <div className="grid grid-cols-2 sm:flex sm:flex-wrap justify-center items-center gap-4 sm:gap-8 md:gap-12">
            <div className="flex items-center justify-center gap-2 text-gray-700">
              <div className="w-8 h-8 sm:w-10 sm:h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                <span className="font-bold text-blue-600 text-xs sm:text-sm">P</span>
              </div>
              <span className="font-semibold text-sm sm:text-base">Protractor</span>
            </div>
            <div className="flex items-center justify-center gap-2 text-gray-700">
              <div className="w-8 h-8 sm:w-10 sm:h-10 bg-orange-100 rounded-lg flex items-center justify-center">
                <span className="font-bold text-orange-600 text-xs sm:text-sm">T</span>
              </div>
              <span className="font-semibold text-sm sm:text-base">Tekmetric</span>
            </div>
            <div className="flex items-center justify-center gap-2 text-gray-700">
              <div className="w-8 h-8 sm:w-10 sm:h-10 bg-green-100 rounded-lg flex items-center justify-center">
                <span className="font-bold text-green-600 text-xs sm:text-sm">C</span>
              </div>
              <span className="font-semibold text-sm sm:text-base">CARFAX</span>
            </div>
            <div className="flex items-center justify-center gap-2 text-gray-700">
              <div className="w-8 h-8 sm:w-10 sm:h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                <span className="font-bold text-purple-600 text-xs sm:text-sm">A</span>
              </div>
              <span className="font-semibold text-sm sm:text-base">AutoFlow</span>
            </div>
          </div>
        </div>
      </section>

      {/* Problem Section */}
      <section className="py-10 sm:py-16 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="bg-gray-50 rounded-xl sm:rounded-2xl p-5 sm:p-8 md:p-12 border border-gray-200">
            <div className="flex flex-col sm:flex-row items-start gap-3 sm:gap-4 mb-5 sm:mb-6">
              <div className="flex-shrink-0 w-10 h-10 sm:w-12 sm:h-12 bg-red-100 rounded-lg sm:rounded-xl flex items-center justify-center">
                <Clock className="w-5 h-5 sm:w-6 sm:h-6 text-red-600" />
              </div>
              <div>
                <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-2">The Real Problem</h2>
                <p className="text-base sm:text-lg text-gray-700 leading-relaxed">
                  Service Advisors spend <span className="font-semibold text-gray-900">10–15 minutes per RO</span> flipping between systems, job history, maintenance guides, and parts catalogs.
                </p>
              </div>
            </div>
            
            <div className="bg-white rounded-lg sm:rounded-xl p-4 sm:p-6 border border-gray-200">
              <p className="text-xs sm:text-sm text-gray-500 mb-3">Quick math owners get instantly:</p>
              <div className="grid grid-cols-3 gap-2 sm:gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold text-gray-900">20 ROs/day</div>
                  <div className="text-sm text-gray-500">× 10 min each</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-gray-900">3.3 hrs/day</div>
                  <div className="text-sm text-gray-500">wasted searching</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-red-600">$6,600+/mo</div>
                  <div className="text-sm text-gray-500">in lost selling time</div>
                </div>
              </div>
            </div>

            <p className="text-center text-gray-600 mt-6 text-lg">
              That's not a productivity problem.<br />
              <span className="font-semibold text-gray-900">That's a revenue problem.</span>
            </p>
          </div>
        </div>
      </section>

      {/* Product Screenshot Showcase */}
      <section className="py-16 bg-gray-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold text-gray-900 text-center mb-4">See It In Action</h2>
          <p className="text-center text-gray-600 mb-10">Everything you need, in one place</p>
          
          <div className="relative">
            <div className="overflow-hidden rounded-2xl shadow-2xl border border-gray-200 bg-white">
              <img 
                src={screenshots[currentSlide].src} 
                alt={screenshots[currentSlide].alt}
                className="w-full h-auto"
              />
            </div>
            
            <div className="absolute inset-y-0 left-0 flex items-center">
              <button 
                onClick={prevSlide}
                className="p-2 -ml-4 bg-white rounded-full shadow-lg border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                <ChevronLeft className="w-6 h-6 text-gray-600" />
              </button>
            </div>
            <div className="absolute inset-y-0 right-0 flex items-center">
              <button 
                onClick={nextSlide}
                className="p-2 -mr-4 bg-white rounded-full shadow-lg border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                <ChevronRight className="w-6 h-6 text-gray-600" />
              </button>
            </div>
          </div>

          <p className="text-center text-gray-700 mt-6 font-medium">{screenshots[currentSlide].caption}</p>
          
          <div className="flex justify-center gap-2 mt-4">
            {screenshots.map((_, i) => (
              <button 
                key={i} 
                onClick={() => setCurrentSlide(i)}
                className={`w-2.5 h-2.5 rounded-full transition-colors ${i === currentSlide ? 'bg-blue-600' : 'bg-gray-300'}`}
              />
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="py-16 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold text-gray-900 text-center mb-4">Choose Your Plan</h2>
          <p className="text-center text-gray-600 mb-12">No long contracts — cancel anytime</p>

          {/* Plan Cards */}
          <div className="grid md:grid-cols-3 gap-6 lg:gap-8 mb-12">
            {plans.map((plan) => (
              <div 
                key={plan.slug}
                className={`relative rounded-2xl p-6 lg:p-8 ${
                  plan.popular 
                    ? 'bg-blue-600 text-white ring-4 ring-blue-600 ring-offset-2' 
                    : 'bg-white border-2 border-gray-200'
                }`}
              >
                {plan.popular && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-orange-500 text-white px-4 py-1 rounded-full text-sm font-semibold">
                    Most Popular
                  </div>
                )}
                <h3 className={`text-2xl font-bold mb-1 ${plan.popular ? 'text-white' : 'text-gray-900'}`}>
                  {plan.name}
                </h3>
                <p className={`text-sm mb-4 ${plan.popular ? 'text-blue-100' : 'text-gray-500'}`}>
                  {plan.description}
                </p>
                <div className="flex items-baseline gap-1 mb-2">
                  <span className={`text-4xl font-bold ${plan.popular ? 'text-white' : 'text-gray-900'}`}>
                    {plan.price}
                  </span>
                  <span className={plan.popular ? 'text-blue-200' : 'text-gray-500'}>/month</span>
                </div>
                <p className={`text-sm mb-6 ${plan.popular ? 'text-blue-100' : 'text-gray-500'}`}>
                  {plan.vins}
                </p>

                <Link 
                  href="/setup"
                  className={`block w-full py-3 rounded-lg font-semibold text-center transition-colors ${
                    plan.popular 
                      ? 'bg-white text-blue-600 hover:bg-blue-50' 
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                >
                  {plan.cta}
                </Link>

                <div className="mt-6 space-y-3">
                  {Object.entries(plan.features).map(([key, included]) => (
                    <div key={key} className="flex items-center gap-2">
                      {included ? (
                        <Check className={`w-5 h-5 flex-shrink-0 ${plan.popular ? 'text-blue-200' : 'text-green-500'}`} />
                      ) : (
                        <X className={`w-5 h-5 flex-shrink-0 ${plan.popular ? 'text-blue-300/50' : 'text-gray-300'}`} />
                      )}
                      <span className={`text-sm ${
                        included 
                          ? (plan.popular ? 'text-white' : 'text-gray-700')
                          : (plan.popular ? 'text-blue-300/50' : 'text-gray-400')
                      }`}>
                        {featureLabels[key]?.name || key}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* A La Carte Add-ons */}
          <div className="bg-gradient-to-r from-purple-50 to-blue-50 rounded-2xl p-6 lg:p-8 border border-purple-100">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
                <ShoppingCart className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-gray-900">A La Carte Add-ons</h3>
                <p className="text-sm text-gray-600">Add features to any plan as needed</p>
              </div>
            </div>
            
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {addOnFeatures.map((feature) => (
                <div key={feature.slug} className="bg-white rounded-xl p-4 border border-gray-200">
                  <h4 className="font-semibold text-gray-900 mb-1">{feature.name}</h4>
                  <p className="text-lg font-bold text-purple-600 mb-2">{feature.price}</p>
                  <p className="text-xs text-gray-500">{feature.description}</p>
                </div>
              ))}
            </div>
          </div>

          {/* VIN Packs */}
          <div className="mt-8 bg-gray-50 rounded-2xl p-6 lg:p-8 border border-gray-200">
            <h3 className="text-xl font-bold text-gray-900 mb-2">Need More VINs?</h3>
            <p className="text-gray-600 mb-6">Add VIN packs anytime after you hit your limit</p>
            <div className="grid sm:grid-cols-3 gap-4">
              <div className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200">
                <span className="font-semibold text-gray-900">100 VINs</span>
                <span className="text-lg font-bold text-gray-900">$39</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200 ring-2 ring-green-500">
                <div>
                  <span className="font-semibold text-gray-900">250 VINs</span>
                  <span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Best Value</span>
                </div>
                <span className="text-lg font-bold text-gray-900">$79</span>
              </div>
              <div className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200">
                <span className="font-semibold text-gray-900">500 VINs</span>
                <span className="text-lg font-bold text-gray-900">$149</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Chrome Extension Section */}
      <section className="py-16 bg-gray-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-orange-100 text-orange-700 rounded-full text-sm font-medium mb-4">
              <span className="font-bold">NEW</span> Tekmetric Chrome Extension
            </div>
            <h2 className="text-3xl font-bold text-gray-900 mb-4">Works Right Inside Tekmetric</h2>
            <p className="text-gray-600 max-w-2xl mx-auto">
              Our Chrome extension brings maintenance plans and job lookup directly into your Tekmetric workflow — no tab switching required.
            </p>
          </div>
          
          <div className="grid md:grid-cols-2 gap-8">
            {chromeExtScreenshots.map((img, i) => (
              <div key={i} className="bg-white rounded-2xl p-4 shadow-lg border border-gray-200">
                <div className="rounded-xl overflow-hidden flex justify-center">
                  <img 
                    src={img.src} 
                    alt={img.alt}
                    className="h-auto max-h-[500px] w-auto"
                  />
                </div>
                <p className="text-center text-gray-700 mt-4 font-medium">{img.caption}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Enterprise Section */}
      <section className="py-16 bg-white border-t border-gray-100">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 px-4 py-2 bg-purple-100 text-purple-700 rounded-full text-sm font-medium mb-4">
              Multi-Location Support
            </div>
            <h2 className="text-3xl font-bold text-gray-900 mb-4">Built for Enterprise</h2>
            <p className="text-gray-600 max-w-2xl mx-auto">
              Running multiple locations? MOS.Tools gives you enterprise-wide visibility with location-specific control.
            </p>
          </div>
          
          <div className="grid md:grid-cols-3 gap-6">
            <div className="bg-purple-50 rounded-xl p-6 border border-purple-100 text-center">
              <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center mx-auto mb-4">
                <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">Cross-Location Search</h3>
              <p className="text-sm text-gray-600">Find jobs across all your shops. See which location did the work.</p>
            </div>
            
            <div className="bg-purple-50 rounded-xl p-6 border border-purple-100 text-center">
              <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center mx-auto mb-4">
                <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">Pooled Repair Data</h3>
              <p className="text-sm text-gray-600">Common Failures draws from all locations — more data, better predictions.</p>
            </div>
            
            <div className="bg-purple-50 rounded-xl p-6 border border-purple-100 text-center">
              <div className="w-12 h-12 bg-purple-100 rounded-xl flex items-center justify-center mx-auto mb-4">
                <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
              </div>
              <h3 className="font-semibold text-gray-900 mb-2">Switch SMS Anytime</h3>
              <p className="text-sm text-gray-600">Move from Protractor to Tekmetric? Your complete job history stays with you.</p>
            </div>
          </div>

          <div className="mt-8 text-center">
            <Link 
              href="mailto:sales@mos.tools?subject=Enterprise Inquiry"
              className="inline-flex items-center gap-2 px-6 py-3 bg-purple-600 text-white rounded-lg font-semibold hover:bg-purple-700 transition-colors"
            >
              Contact Sales for Enterprise Pricing
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* Social Proof Section */}
      <section className="py-16 bg-gray-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-2xl font-bold text-gray-900 text-center mb-10">What Shops Are Saying</h2>
          
          <div className="grid md:grid-cols-3 gap-6">
            {[
              "Saved my advisor 15–20 minutes on every RO.",
              "Found a job from 15 months ago in <10 seconds.",
              "Finally a tool that actually works with Protractor."
            ].map((quote, i) => (
              <div key={i} className="bg-white rounded-xl p-6 border border-gray-200 shadow-sm">
                <Quote className="w-8 h-8 text-blue-200 mb-3" />
                <p className="text-gray-700 italic">"{quote}"</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Demo CTA Section */}
      <section className="py-10 sm:py-16 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-3 sm:mb-4">
            Ready to save hours every week?
          </h2>
          <p className="text-lg sm:text-xl text-gray-600 mb-6 sm:mb-8">
            Get started in minutes — no credit card required for setup.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center">
            <Link 
              href="/setup" 
              className="inline-flex items-center justify-center gap-2 px-6 py-3 sm:px-8 sm:py-4 bg-blue-600 text-white rounded-xl text-base sm:text-lg font-semibold hover:bg-blue-700 transition-colors shadow-lg shadow-blue-600/25"
            >
              Get Started
              <ArrowRight className="w-4 h-4 sm:w-5 sm:h-5" />
            </Link>
            <a 
              href="mailto:support@mos.tools?subject=Demo Request"
              className="inline-flex items-center justify-center gap-2 px-6 py-3 sm:px-8 sm:py-4 border-2 border-gray-200 text-gray-700 rounded-xl text-base sm:text-lg font-semibold hover:border-gray-300 hover:bg-gray-50 transition-colors"
            >
              <Calendar className="w-4 h-4 sm:w-5 sm:h-5" />
              Schedule a Demo
            </a>
          </div>
        </div>
      </section>

      {/* Why Section */}
      <section className="py-8 sm:py-12 bg-gray-50 border-t border-gray-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-gray-600 text-base sm:text-lg leading-relaxed">
            We built this because shops told us this was the #1 pain point.<br className="hidden sm:block" />
            It works with the tools you already use. No fluff — just real time savings.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-200 py-6 sm:py-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center gap-4 sm:gap-6 md:flex-row md:justify-between">
            <div className="flex items-center gap-2 sm:gap-3">
              <img src="/icon.png" alt="MOS.Tools" className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg" />
              <span className="font-bold text-gray-900">MOS.Tools</span>
            </div>
            <div className="flex items-center gap-4 sm:gap-6 text-sm text-gray-600">
              <Link href="/privacy" className="hover:text-gray-900 transition-colors">Privacy Policy</Link>
              <a href="mailto:support@mos.tools" className="hover:text-gray-900 transition-colors">Support</a>
            </div>
            <p className="text-xs sm:text-sm text-gray-500">
              &copy; {new Date().getFullYear()} MOS.Tools. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
