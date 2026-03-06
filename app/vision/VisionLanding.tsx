"use client";

import { useState, useEffect, useRef } from "react";
import { CheckCircle, ArrowRight, Printer, Star, Shield, Zap, Gift, Clock, DollarSign, ChevronRight } from "lucide-react";

const BUY_NOW_URL = "https://crm.myoilsticker.com/payment-link/69aaecca84b2d76696602481";

const SCREENSHOTS = [
  { src: "/screenshots/dashboard.png", label: "Shop Dashboard", desc: "See every vehicle, status, and mileage at a glance" },
  { src: "/screenshots/maintenance-plan.png", label: "Maintenance Plans", desc: "OEM schedules + CARFAX history = zero guesswork" },
  { src: "/screenshots/chrome-ext-plan.png", label: "Detect Dog — Plans", desc: "Maintenance intelligence right inside your SMS" },
  { src: "/screenshots/chrome-ext-job.png", label: "Detect Dog — Jobs", desc: "Find past jobs with pricing in seconds" },
  { src: "/screenshots/oem-data.png", label: "OEM Data", desc: "Factory maintenance specs for every vehicle" },
];

function useInView(threshold = 0.15) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setIsVisible(true); obs.disconnect(); }
    }, { threshold });
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, isVisible };
}

export default function VisionLanding() {
  const [timeLeft, setTimeLeft] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 });
  const [activeShot, setActiveShot] = useState(0);
  const showcaseAnim = useInView(0.1);
  const detectDogAnim = useInView(0.1);
  const featuresAnim = useInView(0.1);
  const pricingAnim = useInView(0.1);


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

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveShot((prev) => (prev + 1) % SCREENSHOTS.length);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white overflow-hidden">
      <style jsx global>{`
        @keyframes float {
          0%, 100% { transform: translateY(0px) rotate(0deg); }
          50% { transform: translateY(-12px) rotate(1deg); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(40px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(-30px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes fadeScale {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes glow {
          0%, 100% { box-shadow: 0 0 20px rgba(59, 130, 246, 0.15); }
          50% { box-shadow: 0 0 40px rgba(59, 130, 246, 0.3); }
        }
        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        .animate-float { animation: float 6s ease-in-out infinite; }
        .animate-slideUp { animation: slideUp 0.7s ease-out forwards; }
        .animate-slideIn { animation: slideIn 0.6s ease-out forwards; }
        .animate-fadeScale { animation: fadeScale 0.6s ease-out forwards; }
        .animate-glow { animation: glow 3s ease-in-out infinite; }
        .stagger-1 { animation-delay: 0.1s; }
        .stagger-2 { animation-delay: 0.2s; }
        .stagger-3 { animation-delay: 0.3s; }
        .stagger-4 { animation-delay: 0.4s; }
        .stagger-5 { animation-delay: 0.5s; }
        .shimmer-text {
          background: linear-gradient(90deg, #60a5fa 0%, #93c5fd 40%, #ffffff 50%, #93c5fd 60%, #60a5fa 100%);
          background-size: 200% auto;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          animation: shimmer 4s linear infinite;
        }
      `}</style>

      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-blue-600/10 rounded-full blur-[120px]"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-blue-400/5 rounded-full blur-[120px]"></div>
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

      <section className="relative pt-16 pb-12 sm:pt-24 sm:pb-16">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
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

          <h1 className="text-4xl sm:text-5xl md:text-7xl font-black leading-[1.1] mb-3 tracking-tight">
            <span className="shimmer-text">The Most Intelligent</span>
            <br />
            <span className="shimmer-text">Oil Sticker</span>
            <br />
            <span className="text-white">on the Planet</span>
          </h1>

          <p className="text-base sm:text-lg text-gray-500 mb-6 italic">
            And it's just the beginning.
          </p>

          <p className="text-lg sm:text-xl text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            MOS Tools takes everything you loved about My Oil Sticker and builds
            a complete operations platform around it — simplifying your service advisors' day
            from clock-in to close.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-10">
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

          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-gray-400 mb-16">
            <span className="flex items-center gap-1.5"><Printer className="w-4 h-4 text-blue-400" /> Printer Included</span>
            <span className="flex items-center gap-1.5"><Gift className="w-4 h-4 text-blue-400" /> 2 Rolls Included</span>
            <span className="flex items-center gap-1.5"><Zap className="w-4 h-4 text-blue-400" /> Setup & Training</span>
            <span className="flex items-center gap-1.5"><Clock className="w-4 h-4 text-blue-400" /> 30 Days of MOS Tools</span>
          </div>

          <div className="max-w-4xl mx-auto">
            <h3 className="text-center text-sm font-semibold text-blue-400 uppercase tracking-widest mb-8">Why Shops Love It</h3>
            <div className="grid grid-cols-3 gap-6 sm:gap-10">
              {[
                { stat: "1-Click", label: "Job Adding" },
                { stat: "15 Min", label: "Saved Per RO" },
                { stat: "$500+", label: "Month Added in Labor Rate Adjustments" },
              ].map((item) => (
                <div key={item.label} className="text-center">
                  <div className="text-3xl sm:text-5xl font-black text-white mb-2">{item.stat}</div>
                  <div className="text-sm sm:text-base text-gray-400">{item.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section ref={showcaseAnim.ref} className="relative py-16 sm:py-24 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/3 left-0 w-72 h-72 bg-blue-600/5 rounded-full blur-[100px]"></div>
          <div className="absolute top-1/3 right-0 w-72 h-72 bg-blue-400/5 rounded-full blur-[100px]"></div>
        </div>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className={`text-center mb-16 transition-all duration-700 ${showcaseAnim.isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
            <p className="text-sm font-medium text-blue-400 uppercase tracking-wider mb-3">What You Get</p>
            <h2 className="text-3xl sm:text-4xl font-bold mb-4">
              The Hardware. <span className="text-blue-400">The Intelligence.</span>
            </h2>
            <p className="text-gray-400 text-lg max-w-2xl mx-auto">
              A professional sticker printer paired with a Chrome extension that knows what every vehicle needs.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8 lg:gap-12 items-start">
            <div className={`transition-all duration-700 ${showcaseAnim.isVisible ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-12'}`}>
              <div className="relative bg-gradient-to-b from-white/[0.06] to-white/[0.02] border border-white/10 rounded-2xl p-6 sm:p-8 hover:border-blue-500/20 transition-colors">
                <div className="flex justify-center mb-6">
                  <div className="relative">
                    <div className="absolute inset-0 bg-blue-500/5 rounded-full blur-[40px] scale-110"></div>
                    <img
                      src="/logos/mos-printer.png"
                      alt="MOS Tools Sticker Printer"
                      className="relative w-56 sm:w-64 animate-float"
                      style={{ animationDelay: '0s' }}
                    />
                  </div>
                </div>
                <h3 className="text-xl sm:text-2xl font-bold text-center mb-2">MOS Sticker Printer</h3>
                <p className="text-sm text-blue-400 text-center font-medium mb-4">The Most Intelligent Oil Sticker on the Planet</p>
                <div className="space-y-2.5">
                  {[
                    "MOS Printer included",
                    "Custom branded stickers with your logo",
                    "QR codes that link customers back to you",
                    "2 rolls of sticker paper included",
                    "Full setup & training — we handle everything",
                  ].map((item) => (
                    <div key={item} className="flex items-start gap-2.5">
                      <CheckCircle className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                      <span className="text-gray-300 text-sm">{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className={`transition-all duration-700 ${showcaseAnim.isVisible ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-12'}`} style={{ transitionDelay: '0.15s' }}>
              <div className="relative bg-gradient-to-b from-white/[0.06] to-white/[0.02] border border-white/10 rounded-2xl p-6 sm:p-8 hover:border-blue-500/20 transition-colors">
                <div className="flex justify-center mb-6">
                  <div className="relative">
                    <div className="absolute inset-0 bg-blue-500/5 rounded-full blur-[40px] scale-110"></div>
                    <img
                      src="/logos/detect-dog.png"
                      alt="Detect Dog by MOS Tools"
                      className="relative w-44 sm:w-52 animate-float"
                      style={{ animationDelay: '3s' }}
                    />
                  </div>
                </div>
                <h3 className="text-xl sm:text-2xl font-bold text-center mb-2">Detect Dog</h3>
                <p className="text-sm text-blue-400 text-center font-medium mb-4">Your advisor's best friend</p>
                <div className="space-y-2.5">
                  {[
                    "Chrome extension inside your SMS",
                    "Works with Tekmetric, Shop-Ware & AutoFlow",
                    "Detects overdue & upcoming maintenance",
                    "Historical job search with AI-assisted matching",
                    "One-click add services to the repair order",
                  ].map((item) => (
                    <div key={item} className="flex items-start gap-2.5">
                      <CheckCircle className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
                      <span className="text-gray-300 text-sm">{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <p className="text-center text-sm text-gray-500 italic mt-8">
            Both included with MOS Tools. No extra cost for Detect Dog.
          </p>
        </div>
      </section>

      <section ref={detectDogAnim.ref} className="relative py-16 sm:py-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className={`text-center mb-12 transition-all duration-700 ${detectDogAnim.isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
            <p className="text-sm font-medium text-blue-400 uppercase tracking-wider mb-3">See It in Action</p>
            <h2 className="text-3xl sm:text-4xl font-bold mb-4">
              More Than a Sticker. <span className="text-blue-400">A Full Platform.</span>
            </h2>
          </div>

          <div className="grid lg:grid-cols-5 gap-8 items-start">
            <div className="lg:col-span-2 space-y-2">
              {SCREENSHOTS.map((shot, i) => (
                <button
                  key={shot.label}
                  onClick={() => setActiveShot(i)}
                  className={`w-full text-left px-4 py-3 rounded-xl transition-all duration-300 ${
                    activeShot === i
                      ? 'bg-blue-600/15 border border-blue-500/30'
                      : 'bg-white/[0.02] border border-transparent hover:bg-white/[0.05] hover:border-white/10'
                  }`}
                  style={detectDogAnim.isVisible ? { animation: `slideIn 0.5s ease-out ${i * 0.1}s both` } : { opacity: 0 }}
                >
                  <div className="flex items-center gap-3">
                    <ChevronRight className={`w-4 h-4 shrink-0 transition-colors ${activeShot === i ? 'text-blue-400' : 'text-gray-600'}`} />
                    <div>
                      <div className={`font-semibold text-sm transition-colors ${activeShot === i ? 'text-white' : 'text-gray-400'}`}>
                        {shot.label}
                      </div>
                      <div className="text-xs text-gray-500">{shot.desc}</div>
                    </div>
                  </div>
                  {activeShot === i && (
                    <div className="mt-2 ml-7 h-0.5 bg-gradient-to-r from-blue-500 to-blue-400 rounded-full" />
                  )}
                </button>
              ))}
            </div>

            <div className={`lg:col-span-3 transition-all duration-700 ${detectDogAnim.isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-12'}`}>
              <div className="relative rounded-2xl overflow-hidden border border-white/10 animate-glow">
                <div className="bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-1.5">
                  <div className="flex items-center gap-1.5 px-3 py-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/60"></div>
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60"></div>
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/60"></div>
                    <span className="ml-2 text-xs text-gray-500">{SCREENSHOTS[activeShot].label}</span>
                  </div>
                </div>
                <div className="relative overflow-hidden">
                  {SCREENSHOTS.map((shot, i) => (
                    <img
                      key={shot.src}
                      src={shot.src}
                      alt={shot.label}
                      loading="lazy"
                      className={`w-full transition-all duration-500 ${
                        activeShot === i ? 'opacity-100 relative' : 'opacity-0 absolute inset-0'
                      }`}
                      style={activeShot === i ? { animation: 'fadeScale 0.5s ease-out' } : undefined}
                    />
                  ))}
                </div>
              </div>
              <div className="flex justify-center gap-2 mt-4">
                {SCREENSHOTS.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveShot(i)}
                    className={`h-1.5 rounded-full transition-all duration-300 ${
                      activeShot === i ? 'w-8 bg-blue-500' : 'w-3 bg-gray-700 hover:bg-gray-600'
                    }`}
                  />
                ))}
              </div>
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
              My Oil Sticker helped countless shops print professional stickers. MOS Tools takes that foundation
              and wraps it in a full operations platform — OEM maintenance intelligence, historical job search,
              shop management integrations, automated booking, and more. Everything a service advisor needs,
              in one place, so they can focus on the customer instead of the computer.
            </p>
          </div>
        </div>
      </section>

      <section ref={pricingAnim.ref} className="relative py-20 sm:py-28">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className={`text-center mb-16 transition-all duration-700 ${pricingAnim.isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
            <h2 className="text-3xl sm:text-4xl font-bold mb-4">
              One Price. <span className="text-blue-400">Two Ways to Go.</span>
            </h2>
            <p className="text-gray-400 text-lg max-w-xl mx-auto">
              Start with the kit. Stay for the full platform.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
            <div
              className={`relative bg-gradient-to-b from-white/[0.06] to-white/[0.02] border border-white/10 rounded-2xl p-8 hover:border-white/20 transition-all duration-700 ${pricingAnim.isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-12'}`}
              style={pricingAnim.isVisible ? { transitionDelay: '0.1s' } : undefined}
            >
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
                  "MOS Printer",
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

            <div
              className={`relative bg-gradient-to-b from-blue-600/10 to-transparent border-2 border-blue-500/40 rounded-2xl p-8 transition-all duration-700 ${pricingAnim.isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-12'}`}
              style={pricingAnim.isVisible ? { transitionDelay: '0.25s' } : undefined}
            >
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
                  "Historical job search & lookup",
                  "Detect Dog extension for your SMS",
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

      <section ref={featuresAnim.ref} className="relative py-20 border-t border-white/10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className={`text-center mb-12 transition-all duration-700 ${featuresAnim.isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
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
                desc: "The same great sticker printing you know, now with custom branding and QR codes that link customers back to your shop.",
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
                title: "Historical Job Search",
                desc: "Search your shop's past jobs with parts and pricing instantly. AI-assisted matching helps advisors build estimates faster.",
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
            ].map((feature, i) => (
              <div
                key={feature.title}
                className={`group bg-white/[0.03] border border-white/10 rounded-xl p-6 hover:bg-white/[0.06] hover:border-blue-500/30 transition-all duration-500 ${featuresAnim.isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}
                style={featuresAnim.isVisible ? { transitionDelay: `${i * 0.1}s` } : undefined}
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
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-bold mb-4">Quick Answers</h2>
          </div>

          <div className="space-y-4">
            {[
              {
                q: "What's included in the $349 Starter Kit?",
                a: "The MOS Printer, 2 rolls of sticker paper, full setup and training, and 30 days of MOS Tools software access. Everything you need to start printing stickers the day it arrives.",
              },
              {
                q: "I used My Oil Sticker before — is this the same thing?",
                a: "MOS Tools is the next generation of My Oil Sticker. You still get the same fast, professional sticker printing — but now it's part of a full operations platform with maintenance intelligence, historical job search assisted by AI, SMS integrations, and more. Everything your advisors wished My Oil Sticker could do.",
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
                a: "MOS Tools integrates with Tekmetric, Protractor, Shop-Ware, and AutoFlow. Our Detect Dog Chrome extension works right inside Tekmetric, Shop-Ware, and AutoFlow — no switching between tabs.",
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
          <p className="text-sm font-medium text-blue-400 uppercase tracking-wider mb-4">
            The Most Intelligent Oil Sticker on the Planet
          </p>
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
              <span className="text-sm text-gray-500">MOS.Tools — The Most Intelligent Oil Sticker on the Planet</span>
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
