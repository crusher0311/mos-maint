"use client";

import { useState, useEffect } from "react";
import { CheckCircle, ArrowRight, Printer, Star, Shield, Zap, Gift, Clock, DollarSign } from "lucide-react";

const BUY_NOW_URL = "#";

export default function VisionLanding() {
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 });

  useEffect(() => {
    const visionEnd = new Date("2026-03-08T18:00:00-06:00");
    const updateCountdown = () => {
      const now = new Date();
      const diff = visionEnd.getTime() - now.getTime();
      if (diff <= 0) {
        setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0 });
        return;
      }
      setTimeLeft({
        days: Math.floor(diff / (1000 * 60 * 60 * 24)),
        hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
        minutes: Math.floor((diff / (1000 * 60)) % 60),
        seconds: Math.floor((diff / 1000) % 60),
      });
    };
    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white overflow-hidden">
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-600/10 rounded-full blur-[120px]"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-400/8 rounded-full blur-[120px]"></div>
      </div>

      <header className="relative z-50 border-b border-white/10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-4">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <img src="/mos-logo.png" alt="MOS.Tools" className="w-10 h-10 rounded-xl" />
                <span className="text-xl font-bold">MOS.Tools</span>
              </div>
              <span className="text-gray-600 hidden sm:inline">×</span>
              <img src="/logos/vision-logo-white.png" alt="Vision Hi-Tech Training & Expo" className="h-8 hidden sm:block" />
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600/15 border border-blue-500/30 rounded-full text-blue-400 text-sm font-medium">
                <Star className="w-3.5 h-3.5" />
                Vision 2026 Exclusive
              </span>
              <a
                href={BUY_NOW_URL}
                className="px-5 py-2.5 bg-blue-600 text-white rounded-lg font-semibold text-sm hover:bg-blue-700 hover:shadow-lg hover:shadow-blue-600/25 transition-all"
              >
                Get the Deal
              </a>
            </div>
          </div>
        </div>
      </header>

      <section className="relative pt-16 pb-20 sm:pt-24 sm:pb-28">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <div>
            <div className="flex items-center justify-center gap-3 mb-8">
              <img src="/logos/vision-logo-white.png" alt="Vision" className="h-6 sm:hidden" />
              <div className="inline-flex items-center gap-2 px-4 py-2 bg-white/5 border border-white/10 rounded-full text-sm text-gray-300">
                <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></span>
                Vision Hi-Tech Training & Expo 2026 — Kansas City
              </div>
            </div>

            <p className="text-sm sm:text-base text-blue-400 font-medium tracking-wide uppercase mb-4">
              My Oil Sticker — Reimagined
            </p>

            <h1 className="text-4xl sm:text-5xl md:text-7xl font-black leading-[1.1] mb-6 tracking-tight">
              Your Sticker Printer,
              <br />
              <span className="bg-gradient-to-r from-blue-400 via-blue-500 to-blue-600 bg-clip-text text-transparent">
                Now a Full Shop
              </span>
              <br />
              <span className="bg-gradient-to-r from-blue-400 via-blue-500 to-blue-600 bg-clip-text text-transparent">
                Operations Tool
              </span>
            </h1>

            <p className="text-lg sm:text-xl text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed">
              MOS Tools takes everything you loved about My Oil Sticker and builds
              a complete operations platform around it — simplifying your service advisors' day
              from clock-in to close.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12">
              <a
                href={BUY_NOW_URL}
                className="group inline-flex items-center gap-3 px-8 py-4 bg-blue-600 text-white rounded-xl text-lg font-bold hover:bg-blue-700 hover:shadow-2xl hover:shadow-blue-600/30 transition-all hover:scale-[1.02]"
              >
                Claim Your Vision Deal — $349
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </a>
              <span className="text-sm text-gray-500">
                <span className="line-through text-gray-600">$495</span>{" "}
                <span className="text-blue-400 font-semibold">Save $146</span>
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-gray-400">
              <span className="flex items-center gap-1.5"><Printer className="w-4 h-4 text-blue-400" /> Printer Included</span>
              <span className="flex items-center gap-1.5"><Gift className="w-4 h-4 text-blue-400" /> 2 Rolls Included</span>
              <span className="flex items-center gap-1.5"><Zap className="w-4 h-4 text-blue-400" /> Setup & Training</span>
              <span className="flex items-center gap-1.5"><Clock className="w-4 h-4 text-blue-400" /> 30 Days of MOS Tools</span>
            </div>
          </div>
        </div>
      </section>

      <section className="relative py-6 border-y border-white/10 bg-white/[0.02]">
        <div className="max-w-4xl mx-auto px-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
            {[
              { value: String(timeLeft.days).padStart(2, '0'), label: "Days" },
              { value: String(timeLeft.hours).padStart(2, '0'), label: "Hours" },
              { value: String(timeLeft.minutes).padStart(2, '0'), label: "Minutes" },
              { value: String(timeLeft.seconds).padStart(2, '0'), label: "Seconds" },
            ].map((unit) => (
              <div key={unit.label} className="flex flex-col items-center">
                <span className="text-3xl sm:text-4xl font-mono font-bold text-blue-400">{unit.value}</span>
                <span className="text-xs text-gray-500 uppercase tracking-wider mt-1">{unit.label}</span>
              </div>
            ))}
          </div>
          <p className="text-center text-sm text-gray-500 mt-3">Show special ends when Vision closes</p>
        </div>
      </section>

      <section className="relative py-12 sm:py-16 border-b border-white/10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="bg-gradient-to-r from-blue-600/10 to-blue-400/5 border border-blue-500/20 rounded-2xl p-8 sm:p-10 text-center">
            <p className="text-sm font-medium text-blue-400 uppercase tracking-wider mb-3">The Evolution</p>
            <h2 className="text-2xl sm:text-3xl font-bold mb-4">
              From <span className="text-gray-400">My Oil Sticker</span> to <span className="text-blue-400">MOS Tools</span>
            </h2>
            <p className="text-gray-400 max-w-2xl mx-auto leading-relaxed">
              My Oil Sticker helped thousands of shops print professional stickers. MOS Tools takes that foundation
              and wraps it in a full operations platform — OEM maintenance intelligence, AI-powered job search,
              shop management integrations, automated booking, and more. Everything a service advisor needs,
              in one place, so they can focus on the customer instead of the computer.
            </p>
          </div>
        </div>
      </section>

      <section className="relative py-20 sm:py-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold mb-4">
              One Price. <span className="text-blue-400">Two Ways to Go.</span>
            </h2>
            <p className="text-gray-400 text-lg max-w-xl mx-auto">
              Start with the kit. Stay for the full platform.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
            <div className="relative bg-gradient-to-b from-white/[0.06] to-white/[0.02] border border-white/10 rounded-2xl p-8 hover:border-white/20 transition-colors">
              <div className="mb-6">
                <span className="text-sm font-medium text-gray-400 uppercase tracking-wider">Vision Special</span>
                <div className="flex items-baseline gap-2 mt-2">
                  <span className="text-5xl font-black text-white">$349</span>
                  <span className="text-lg text-gray-500 line-through">$495</span>
                </div>
                <p className="text-blue-400 font-semibold mt-1">Save $146 — one-time purchase</p>
              </div>
              <div className="space-y-3 mb-8">
                {[
                  "Zink Happy Thermal Printer",
                  "2 rolls of sticker paper",
                  "Full setup & training",
                  "30 days of MOS Tools included",
                  "Print stickers in seconds",
                  "Custom branding for your shop",
                ].map((item) => (
                  <div key={item} className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
                    <span className="text-gray-300">{item}</span>
                  </div>
                ))}
              </div>
              <a
                href={BUY_NOW_URL}
                className="block w-full text-center px-6 py-3.5 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 hover:shadow-lg hover:shadow-blue-600/25 transition-all"
              >
                Get Started — $349
              </a>
            </div>

            <div className="relative bg-gradient-to-b from-blue-600/10 to-transparent border-2 border-blue-500/40 rounded-2xl p-8">
              <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                <span className="px-4 py-1.5 bg-blue-600 text-white text-xs font-bold uppercase tracking-wider rounded-full">
                  Best Long-Term Value
                </span>
              </div>
              <div className="mb-6 mt-2">
                <span className="text-sm font-medium text-gray-400 uppercase tracking-wider">Stay with MOS Tools</span>
                <div className="flex items-baseline gap-2 mt-2">
                  <span className="text-5xl font-black text-white">$199</span>
                  <span className="text-lg text-gray-400">.95/mo</span>
                </div>
                <p className="text-blue-400 font-semibold mt-1">Guaranteed lifetime monthly price</p>
              </div>
              <div className="space-y-3 mb-8">
                {[
                  "Everything in the Starter Kit",
                  "Full MOS Tools platform access",
                  "Vehicle maintenance intelligence",
                  "CARFAX integration & history",
                  "AI-powered job search & lookup",
                  "Chrome extension for your SMS",
                  "Auto booking & labor rate rules",
                  "Every new feature we release — forever",
                ].map((item) => (
                  <div key={item} className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 text-blue-500 shrink-0 mt-0.5" />
                    <span className="text-gray-300">{item}</span>
                  </div>
                ))}
              </div>
              <div className="bg-white/5 border border-white/10 rounded-xl p-4 mb-6">
                <div className="flex items-center gap-2 mb-1">
                  <Shield className="w-4 h-4 text-blue-400" />
                  <span className="text-sm font-semibold text-white">Lifetime Price Lock</span>
                </div>
                <p className="text-xs text-gray-400">
                  Your $199.95/mo rate is locked in forever. Even as we add features and raise prices for new customers, your rate never changes.
                </p>
              </div>
              <a
                href={BUY_NOW_URL}
                className="block w-full text-center px-6 py-3.5 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 hover:shadow-lg hover:shadow-blue-600/25 transition-all"
              >
                Get the Full Platform
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="relative py-20 border-t border-white/10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-bold mb-4">
              Built to Simplify <span className="text-blue-400">Your Advisor's Day</span>
            </h2>
            <p className="text-gray-400 text-lg max-w-xl mx-auto">
              Every feature is designed to save your service advisors time and help them sell smarter.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              {
                icon: <Printer className="w-6 h-6" />,
                title: "Instant Oil Stickers",
                desc: "The same great sticker printing you know, now with custom branding, QR codes, and under-5-second print times.",
              },
              {
                icon: <Zap className="w-6 h-6" />,
                title: "Vehicle Health Intelligence",
                desc: "OEM maintenance schedules combined with CARFAX history to show exactly what every car needs — no more guessing.",
              },
              {
                icon: <Shield className="w-6 h-6" />,
                title: "Works with Your SMS",
                desc: "Integrates with Tekmetric, Protractor, Shop-Ware, and AutoFlow. Your advisor never leaves their workflow.",
              },
              {
                icon: <Star className="w-6 h-6" />,
                title: "AI Job Search",
                desc: "Find past jobs with parts and pricing instantly. Smart autocomplete helps advisors build estimates faster.",
              },
              {
                icon: <DollarSign className="w-6 h-6" />,
                title: "Auto Labor Rate Rules",
                desc: "Automatically apply the right labor rate based on vehicle, customer, or job type. No manual overrides needed.",
              },
              {
                icon: <Clock className="w-6 h-6" />,
                title: "Auto Booking",
                desc: "Predictive scheduling based on driving habits. Automated reminders keep customers coming back on time.",
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="group bg-white/[0.03] border border-white/10 rounded-xl p-6 hover:bg-white/[0.06] hover:border-blue-500/30 transition-all"
              >
                <div className="w-12 h-12 bg-blue-600/15 rounded-xl flex items-center justify-center text-blue-400 mb-4 group-hover:bg-blue-600/25 transition-colors">
                  {feature.icon}
                </div>
                <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
                <p className="text-sm text-gray-400 leading-relaxed">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative py-20 border-t border-white/10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-bold mb-4">
              Why Shops <span className="text-blue-400">Love It</span>
            </h2>
          </div>

          <div className="grid sm:grid-cols-3 gap-8 text-center">
            {[
              { stat: "< 5 sec", label: "To print a sticker" },
              { stat: "4 SMS", label: "Integrations supported" },
              { stat: "$0", label: "Setup hassle — we handle it" },
            ].map((item) => (
              <div key={item.label}>
                <div className="text-4xl sm:text-5xl font-black text-blue-400 mb-2">{item.stat}</div>
                <div className="text-gray-400">{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative py-20 border-t border-white/10">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-bold mb-4">Quick Answers</h2>
          </div>

          <div className="space-y-4">
            {[
              {
                q: "What's included in the $349 Starter Kit?",
                a: "A Zink Happy thermal printer, 2 rolls of sticker paper, full setup and training, and 30 days of MOS Tools software access. Everything you need to start printing stickers the day it arrives.",
              },
              {
                q: "I used My Oil Sticker before — is this the same thing?",
                a: "MOS Tools is the next generation of My Oil Sticker. You still get the same fast, professional sticker printing — but now it's part of a full operations platform with maintenance intelligence, AI job search, SMS integrations, and more. Everything your advisors wished My Oil Sticker could do.",
              },
              {
                q: "What happens after the 30 days?",
                a: "You can continue using MOS Tools at the special Vision rate of $199.95/month — locked in for life. Or if you just want to use the printer on its own, there's no obligation to continue with the software.",
              },
              {
                q: "What does \"lifetime price lock\" mean?",
                a: "It means your $199.95/month rate never increases. As we add new features and raise prices for new customers, your rate stays the same. Forever.",
              },
              {
                q: "What shop management systems do you work with?",
                a: "MOS Tools integrates with Tekmetric, Protractor, Shop-Ware, and AutoFlow. Our Chrome extension works right inside your SMS — no switching between tabs.",
              },
              {
                q: "Is this deal only available at Vision?",
                a: "Yes. The $349 Starter Kit pricing and the $199.95/month lifetime rate are exclusive to Vision 2026 attendees. Once the show ends, it goes back to regular pricing.",
              },
              {
                q: "How fast can I start printing?",
                a: "Most shops are printing stickers within minutes of setup. The printer is plug-and-play, and we walk you through everything.",
              },
            ].map((faq) => (
              <details
                key={faq.q}
                className="group bg-white/[0.03] border border-white/10 rounded-xl overflow-hidden hover:border-white/20 transition-colors"
              >
                <summary className="flex items-center justify-between px-6 py-4 cursor-pointer list-none">
                  <span className="font-semibold text-white pr-4">{faq.q}</span>
                  <span className="text-gray-500 group-open:rotate-45 transition-transform text-xl shrink-0">+</span>
                </summary>
                <div className="px-6 pb-4 text-gray-400 text-sm leading-relaxed">{faq.a}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="relative py-20 sm:py-28 border-t border-white/10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold mb-4">
            Don't Miss This Deal
          </h2>
          <p className="text-lg text-gray-400 mb-8 max-w-xl mx-auto">
            The Vision special ends when the show closes. Lock in your lifetime rate and give your advisors
            the tool they've been waiting for.
          </p>

          <a
            href={BUY_NOW_URL}
            className="group inline-flex items-center gap-3 px-10 py-5 bg-blue-600 text-white rounded-xl text-xl font-bold hover:bg-blue-700 hover:shadow-2xl hover:shadow-blue-600/30 transition-all hover:scale-[1.02]"
          >
            Claim Your Vision Deal — $349
            <ArrowRight className="w-6 h-6 group-hover:translate-x-1 transition-transform" />
          </a>

          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-gray-500 mt-6">
            <span className="flex items-center gap-1.5"><CheckCircle className="w-4 h-4 text-blue-500" /> Printer + 2 Rolls</span>
            <span className="flex items-center gap-1.5"><CheckCircle className="w-4 h-4 text-blue-500" /> Full Setup & Training</span>
            <span className="flex items-center gap-1.5"><CheckCircle className="w-4 h-4 text-blue-500" /> 30 Days MOS Tools</span>
            <span className="flex items-center gap-1.5"><CheckCircle className="w-4 h-4 text-blue-500" /> $199.95/mo Lifetime Rate</span>
          </div>
        </div>
      </section>

      <footer className="border-t border-white/10 py-8">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <img src="/mos-logo.png" alt="MOS.Tools" className="w-8 h-8 rounded-lg" />
              <span className="text-sm text-gray-500">MOS.Tools — My Oil Sticker, Reimagined</span>
            </div>
            <div className="flex items-center gap-3">
              <img src="/logos/vision-logo-white.png" alt="Vision" className="h-5 opacity-50" />
              <span className="text-sm text-gray-600">Vision 2026 — Kansas City, MO</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
