"use client";

import { useState, useEffect } from "react";
import { Wrench, Clock, CheckCircle, ArrowRight, Play, Calendar, Quote } from "lucide-react";
import Link from "next/link";

export default function LandingPage() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="bg-white border-b border-gray-100 sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center">
                <Wrench className="w-6 h-6 text-white" />
              </div>
              <span className="text-xl font-bold text-gray-900">MOS.Tools</span>
            </div>
            <div className="flex items-center gap-4">
              <Link href="/login" className="px-4 py-2 text-gray-600 hover:text-gray-900 font-medium transition-colors">
                Sign In
              </Link>
              <Link href="/setup" className="px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium">
                Start MOS Pro
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative">
        <div className="absolute inset-0 bg-gradient-to-b from-blue-50 to-white"></div>
        <div className="relative max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 pb-20">
          <div className={`text-center transition-all duration-700 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
            <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 leading-tight mb-4">
              Maintenance Intelligence<br />
              <span className="text-blue-600">Built for Protractor Shops</span>
            </h1>
            
            <p className="text-xl sm:text-2xl text-gray-600 mb-8 max-w-2xl mx-auto">
              Stop digging. Start knowing what cars need — instantly.
            </p>

            <Link 
              href="/setup" 
              className="inline-flex items-center gap-2 px-8 py-4 bg-blue-600 text-white rounded-xl text-lg font-semibold hover:bg-blue-700 transition-colors shadow-lg shadow-blue-600/25"
            >
              Start MOS Pro — $199/mo
              <ArrowRight className="w-5 h-5" />
            </Link>
            <p className="text-sm text-gray-500 mt-3">300 VINs included</p>
          </div>
        </div>
      </section>

      {/* Problem Section */}
      <section className="py-16 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="bg-gray-50 rounded-2xl p-8 sm:p-12 border border-gray-200">
            <div className="flex items-start gap-4 mb-6">
              <div className="flex-shrink-0 w-12 h-12 bg-red-100 rounded-xl flex items-center justify-center">
                <Clock className="w-6 h-6 text-red-600" />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-gray-900 mb-2">The Real Problem</h2>
                <p className="text-lg text-gray-700 leading-relaxed">
                  Service Advisors spend <span className="font-semibold text-gray-900">10–15 minutes per RO</span> flipping between Protractor, job history, maintenance guides, and parts catalogs — because nothing ties it together contextually.
                </p>
              </div>
            </div>
            
            <div className="bg-white rounded-xl p-6 border border-gray-200">
              <p className="text-sm text-gray-500 mb-3">Quick math owners get instantly:</p>
              <div className="grid sm:grid-cols-3 gap-4 text-center">
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

      {/* What You Get Section */}
      <section className="py-16 bg-gray-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold text-gray-900 text-center mb-12">What You Get</h2>
          
          <div className="space-y-6">
            <div className="bg-white rounded-xl p-6 border border-gray-200 shadow-sm">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <CheckCircle className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">Maintenance Lookup with Context</h3>
                  <p className="text-gray-600">
                    Live Protractor logic + real shop history = smarter recommendations. Not generic schedules — actual intelligence based on what you've done before.
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl p-6 border border-gray-200 shadow-sm">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <CheckCircle className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">Job History You Can Trust</h3>
                  <p className="text-gray-600">
                    See actual repairs that were invoiced, not guesses. Find any job your shop has done in seconds — even from 15 months ago.
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl p-6 border border-gray-200 shadow-sm">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <CheckCircle className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 mb-1">Hard-to-Find Parts Cross-Reference</h3>
                  <p className="text-gray-600">
                    Stop re-searching the same parts over and over. Quick access to parts you've used before on similar vehicles.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section className="py-16 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold text-gray-900 text-center mb-4">Simple Pricing</h2>
          <p className="text-center text-gray-600 mb-12">No long contracts — cancel anytime</p>

          <div className="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto">
            {/* MOS Pro */}
            <div className="bg-blue-600 rounded-2xl p-8 text-white relative overflow-hidden">
              <div className="absolute top-4 right-4 bg-white/20 backdrop-blur-sm px-3 py-1 rounded-full text-sm font-medium">
                Founding Shop Pricing
              </div>
              <h3 className="text-2xl font-bold mb-2">MOS Pro</h3>
              <div className="flex items-baseline gap-1 mb-4">
                <span className="text-4xl font-bold">$199</span>
                <span className="text-blue-200">/month</span>
              </div>
              <ul className="space-y-3 mb-8">
                <li className="flex items-center gap-2">
                  <CheckCircle className="w-5 h-5 text-blue-200" />
                  <span>Up to 300 VINs / month</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle className="w-5 h-5 text-blue-200" />
                  <span>Priority support</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle className="w-5 h-5 text-blue-200" />
                  <span>Founding Shop pricing locked for life</span>
                </li>
              </ul>
              <Link 
                href="/setup"
                className="block w-full py-3 bg-white text-blue-600 rounded-lg font-semibold text-center hover:bg-blue-50 transition-colors"
              >
                Start MOS Pro
              </Link>
            </div>

            {/* VIN Packs */}
            <div className="bg-gray-50 rounded-2xl p-8 border border-gray-200">
              <h3 className="text-xl font-bold text-gray-900 mb-2">Need More VINs?</h3>
              <p className="text-gray-600 mb-6">Add VIN packs anytime after you hit your limit</p>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200">
                  <div>
                    <span className="font-semibold text-gray-900">100 VINs</span>
                  </div>
                  <span className="text-lg font-bold text-gray-900">$39</span>
                </div>
                <div className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200">
                  <div>
                    <span className="font-semibold text-gray-900">250 VINs</span>
                    <span className="ml-2 text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Best Value</span>
                  </div>
                  <span className="text-lg font-bold text-gray-900">$79</span>
                </div>
              </div>
            </div>
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
      <section className="py-16 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-bold text-gray-900 mb-4">
            Still unsure?
          </h2>
          <p className="text-xl text-gray-600 mb-8">
            Book a 10-min demo — and see how MOS.Tools can save advisor time today.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link 
              href="/setup" 
              className="inline-flex items-center justify-center gap-2 px-8 py-4 bg-blue-600 text-white rounded-xl text-lg font-semibold hover:bg-blue-700 transition-colors shadow-lg shadow-blue-600/25"
            >
              Start MOS Pro — $199/mo
              <ArrowRight className="w-5 h-5" />
            </Link>
            <a 
              href="mailto:support@mos.tools?subject=Demo Request"
              className="inline-flex items-center justify-center gap-2 px-8 py-4 border-2 border-gray-200 text-gray-700 rounded-xl text-lg font-semibold hover:border-gray-300 hover:bg-gray-50 transition-colors"
            >
              <Calendar className="w-5 h-5" />
              Schedule a Demo
            </a>
          </div>
        </div>
      </section>

      {/* Why Section */}
      <section className="py-12 bg-gray-50 border-t border-gray-200">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p className="text-gray-600 text-lg leading-relaxed">
            We built this because shops told us this was the #1 pain point.<br />
            It works with the tools you already use. No fluff — just real time savings.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-200 py-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <Wrench className="w-5 h-5 text-white" />
              </div>
              <span className="font-bold text-gray-900">MOS.Tools</span>
            </div>
            <div className="flex items-center gap-6 text-sm text-gray-600">
              <Link href="/privacy" className="hover:text-gray-900 transition-colors">Privacy Policy</Link>
              <a href="mailto:support@mos.tools" className="hover:text-gray-900 transition-colors">Support</a>
            </div>
            <p className="text-sm text-gray-500">
              &copy; {new Date().getFullYear()} MOS.Tools. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
