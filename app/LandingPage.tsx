"use client";

import { useState, useEffect } from "react";

export default function LandingPage() {
  const [activeDemo, setActiveDemo] = useState(0);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  const demos = [
    {
      title: "AI-Powered Analysis",
      description: "Get instant maintenance recommendations based on vehicle history, mileage, and manufacturer specs",
      preview: {
        type: "analysis",
        data: {
          vehicle: "2019 Ford F-150",
          vin: "1FTEW1EP7KFC10312",
          recommendations: [
            { service: "Oil Change", status: "Due Now", priority: "high" },
            { service: "Brake Inspection", status: "Due in 2,000 mi", priority: "medium" },
            { service: "Transmission Service", status: "Due in 5,000 mi", priority: "low" }
          ]
        }
      }
    },
    {
      title: "Interactive Maintenance Plans",
      description: "Visual maintenance schedules that update in real-time as work is completed",
      preview: {
        type: "plan",
        data: {
          upcoming: ["Oil Change (Now)", "Tire Rotation (1,200 mi)", "Air Filter (2,500 mi)"],
          completed: ["Brake Pads", "Coolant Flush", "Battery Test"]
        }
      }
    },
    {
      title: "Customer Dashboard",
      description: "Comprehensive view of all customer vehicles, service history, and upcoming needs",
      preview: {
        type: "dashboard",
        data: {
          customers: 247,
          vehicles: 1834,
          revenue: "$45,239",
          pending: 23
        }
      }
    }
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-indigo-900 relative overflow-hidden">
      {/* Animated background elements */}
      <div className="absolute inset-0">
        <div className="absolute top-20 left-20 w-72 h-72 bg-blue-500/10 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-20 right-20 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl animate-pulse delay-1000"></div>
        <div className="absolute top-1/2 left-1/2 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl animate-pulse delay-500"></div>
      </div>

      {/* Header */}
      <header className="relative bg-black/20 backdrop-blur-sm border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-gradient-to-br from-blue-400 to-purple-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-lg">M</span>
              </div>
              <h1 className="text-2xl font-bold text-white">MOS Maintenance</h1>
            </div>
            <div className="flex items-center space-x-4">
              <a href="/login" className="px-6 py-2 text-gray-300 hover:text-white transition-colors">
                Sign In
              </a>
              <a href="/setup" className="px-6 py-3 bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-lg hover:from-blue-600 hover:to-purple-700 transition-all duration-200 shadow-lg hover:shadow-xl transform hover:scale-105">
                Start Free Trial
              </a>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="relative">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 pb-16">
          <div className={`text-center transition-all duration-1000 ${isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-10'}`}>
            <h1 className="text-5xl md:text-7xl font-bold text-white mb-6 leading-tight">
              The Future of
              <span className="block bg-gradient-to-r from-blue-400 via-purple-500 to-cyan-400 bg-clip-text text-transparent">
                Vehicle Maintenance
              </span>
            </h1>
            <p className="text-xl md:text-2xl text-gray-300 mb-8 max-w-4xl mx-auto leading-relaxed">
              Revolutionize your automotive business with AI-powered maintenance recommendations, 
              intelligent scheduling, and comprehensive fleet management.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-16">
              <a href="/setup" className="px-8 py-4 bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-xl text-lg font-semibold hover:from-blue-600 hover:to-purple-700 transition-all duration-200 shadow-xl hover:shadow-2xl transform hover:scale-105">
                Start Your Free Trial
              </a>
              <a href="#demo" className="px-8 py-4 border-2 border-white/20 text-white rounded-xl text-lg font-semibold hover:bg-white/10 transition-all duration-200 backdrop-blur-sm">
                Watch Demo
              </a>
            </div>
          </div>

          {/* Interactive Demo Section */}
          <div id="demo" className="mt-20">
            <div className="text-center mb-12">
              <h2 className="text-4xl font-bold text-white mb-4">See It In Action</h2>
              <p className="text-xl text-gray-300">Experience the power of intelligent maintenance management</p>
            </div>

            {/* Demo Navigation */}
            <div className="flex flex-wrap justify-center gap-4 mb-8">
              {demos.map((demo, index) => (
                <button
                  key={index}
                  onClick={() => setActiveDemo(index)}
                  className={`px-6 py-3 rounded-lg font-semibold transition-all duration-200 ${
                    activeDemo === index
                      ? 'bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg'
                      : 'bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white'
                  }`}
                >
                  {demo.title}
                </button>
              ))}
            </div>

            {/* Demo Preview */}
            <div className="bg-black/30 backdrop-blur-sm rounded-2xl p-8 border border-white/10 shadow-2xl">
              <div className="grid lg:grid-cols-2 gap-8 items-center">
                <div>
                  <h3 className="text-3xl font-bold text-white mb-4">{demos[activeDemo].title}</h3>
                  <p className="text-xl text-gray-300 mb-6 leading-relaxed">{demos[activeDemo].description}</p>
                  
                  {/* Demo Content */}
                  {demos[activeDemo].preview.type === 'analysis' && (
                    <div className="space-y-4">
                      <div className="bg-white/10 rounded-lg p-4 border border-white/20">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-white font-semibold">{demos[activeDemo].preview.data.vehicle}</span>
                          <span className="text-xs text-gray-400">VIN: {demos[activeDemo].preview.data.vin}</span>
                        </div>
                        <div className="space-y-2">
                          {demos[activeDemo].preview.data.recommendations.map((rec, i) => (
                            <div key={i} className="flex items-center justify-between p-3 bg-black/20 rounded">
                              <span className="text-white">{rec.service}</span>
                              <div className="flex items-center space-x-2">
                                <span className={`w-2 h-2 rounded-full ${
                                  rec.priority === 'high' ? 'bg-red-400' : 
                                  rec.priority === 'medium' ? 'bg-yellow-400' : 'bg-green-400'
                                }`}></span>
                                <span className="text-gray-300 text-sm">{rec.status}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {demos[activeDemo].preview.type === 'plan' && (
                    <div className="space-y-4">
                      <div className="bg-white/10 rounded-lg p-4 border border-white/20">
                        <h4 className="text-white font-semibold mb-3">Upcoming Services</h4>
                        {demos[activeDemo].preview.data.upcoming.map((service, i) => (
                          <div key={i} className="flex items-center space-x-3 p-2 bg-blue-500/20 rounded mb-2">
                            <div className="w-2 h-2 bg-blue-400 rounded-full"></div>
                            <span className="text-white">{service}</span>
                          </div>
                        ))}
                      </div>
                      <div className="bg-white/10 rounded-lg p-4 border border-white/20">
                        <h4 className="text-white font-semibold mb-3">Recently Completed</h4>
                        {demos[activeDemo].preview.data.completed.map((service, i) => (
                          <div key={i} className="flex items-center space-x-3 p-2 bg-green-500/20 rounded mb-2">
                            <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                            <span className="text-white">{service}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {demos[activeDemo].preview.type === 'dashboard' && (
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-white/10 rounded-lg p-4 border border-white/20 text-center">
                        <div className="text-3xl font-bold text-blue-400">{demos[activeDemo].preview.data.customers}</div>
                        <div className="text-gray-300">Active Customers</div>
                      </div>
                      <div className="bg-white/10 rounded-lg p-4 border border-white/20 text-center">
                        <div className="text-3xl font-bold text-purple-400">{demos[activeDemo].preview.data.vehicles}</div>
                        <div className="text-gray-300">Vehicles Tracked</div>
                      </div>
                      <div className="bg-white/10 rounded-lg p-4 border border-white/20 text-center">
                        <div className="text-3xl font-bold text-green-400">{demos[activeDemo].preview.data.revenue}</div>
                        <div className="text-gray-300">Monthly Revenue</div>
                      </div>
                      <div className="bg-white/10 rounded-lg p-4 border border-white/20 text-center">
                        <div className="text-3xl font-bold text-yellow-400">{demos[activeDemo].preview.data.pending}</div>
                        <div className="text-gray-300">Pending Services</div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="relative">
                  {/* Mock Browser Window */}
                  <div className="bg-white/5 rounded-lg border border-white/20 overflow-hidden shadow-2xl">
                    <div className="bg-white/10 px-4 py-3 flex items-center space-x-2 border-b border-white/20">
                      <div className="w-3 h-3 bg-red-400 rounded-full"></div>
                      <div className="w-3 h-3 bg-yellow-400 rounded-full"></div>
                      <div className="w-3 h-3 bg-green-400 rounded-full"></div>
                      <div className="flex-1 bg-white/10 rounded px-3 py-1 text-xs text-gray-400 ml-4">
                        mos-maintenance.com/dashboard
                      </div>
                    </div>
                    <div className="p-6 h-64 bg-gradient-to-br from-slate-800 to-slate-900">
                      <div className="animate-pulse space-y-3">
                        <div className="h-8 bg-white/20 rounded w-3/4"></div>
                        <div className="space-y-2">
                          <div className="h-4 bg-white/10 rounded"></div>
                          <div className="h-4 bg-white/10 rounded w-5/6"></div>
                          <div className="h-4 bg-white/10 rounded w-4/6"></div>
                        </div>
                        <div className="grid grid-cols-3 gap-2 mt-4">
                          <div className="h-16 bg-white/10 rounded"></div>
                          <div className="h-16 bg-white/10 rounded"></div>
                          <div className="h-16 bg-white/10 rounded"></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Features Section */}
        <div className="bg-black/20 backdrop-blur-sm py-20 mt-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-16">
              <h2 className="text-4xl font-bold text-white mb-4">Everything You Need</h2>
              <p className="text-xl text-gray-300">Comprehensive tools for modern automotive businesses</p>
            </div>

            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
              {[
                {
                  icon: "🤖",
                  title: "AI-Powered Insights",
                  description: "Machine learning algorithms analyze vehicle data to predict maintenance needs and optimize service schedules."
                },
                {
                  icon: "📊",
                  title: "Real-Time Analytics",
                  description: "Live dashboards showing business performance, customer trends, and revenue optimization opportunities."
                },
                {
                  icon: "🔗",
                  title: "Seamless Integration",
                  description: "Connect with AutoFlow, Carfax, DVI systems, and other industry-standard tools you already use."
                },
                {
                  icon: "📱",
                  title: "Mobile First",
                  description: "Access everything from anywhere. Fully responsive design works perfectly on all devices."
                },
                {
                  icon: "⚡",
                  title: "Lightning Fast",
                  description: "Advanced caching and optimization ensure instant loading, even with large fleet datasets."
                },
                {
                  icon: "🛡️",
                  title: "Enterprise Security",
                  description: "Bank-level encryption and security protocols protect your business and customer data."
                }
              ].map((feature, index) => (
                <div key={index} className="group bg-white/5 backdrop-blur-sm rounded-xl p-6 border border-white/10 hover:bg-white/10 transition-all duration-300 hover:scale-105">
                  <div className="text-4xl mb-4">{feature.icon}</div>
                  <h3 className="text-xl font-bold text-white mb-3">{feature.title}</h3>
                  <p className="text-gray-300 leading-relaxed">{feature.description}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Social Proof Section */}
        <div className="py-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <h2 className="text-4xl font-bold text-white mb-8">Trusted by Industry Leaders</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-16">
              {[
                { value: "500+", label: "Auto Shops" },
                { value: "50K+", label: "Vehicles Tracked" },
                { value: "$2M+", label: "Revenue Generated" },
                { value: "99.9%", label: "Uptime" }
              ].map((stat, index) => (
                <div key={index} className="text-center">
                  <div className="text-4xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent mb-2">
                    {stat.value}
                  </div>
                  <div className="text-gray-300">{stat.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* CTA Section */}
        <div className="bg-gradient-to-r from-blue-600 to-purple-700 py-16">
          <div className="max-w-4xl mx-auto text-center px-4 sm:px-6 lg:px-8">
            <h2 className="text-4xl font-bold text-white mb-6">
              Ready to Transform Your Business?
            </h2>
            <p className="text-xl text-blue-100 mb-8">
              Join thousands of automotive professionals who've revolutionized their operations with MOS Maintenance.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <a href="/setup" className="px-8 py-4 bg-white text-blue-600 rounded-xl text-lg font-semibold hover:bg-gray-100 transition-all duration-200 shadow-xl hover:shadow-2xl transform hover:scale-105">
                Start Free 30-Day Trial
              </a>
              <a href="/login" className="px-8 py-4 border-2 border-white text-white rounded-xl text-lg font-semibold hover:bg-white/10 transition-all duration-200">
                Schedule Demo
              </a>
            </div>
            <p className="text-sm text-blue-200 mt-4">No credit card required • Setup in under 5 minutes</p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-black/40 backdrop-blur-sm border-t border-white/10 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-4 gap-8">
            <div className="md:col-span-2">
              <div className="flex items-center space-x-3 mb-4">
                <div className="w-8 h-8 bg-gradient-to-br from-blue-400 to-purple-600 rounded-lg flex items-center justify-center">
                  <span className="text-white font-bold">M</span>
                </div>
                <span className="text-xl font-bold text-white">MOS Maintenance</span>
              </div>
              <p className="text-gray-400 max-w-md">
                The next generation of vehicle maintenance management. Intelligent, efficient, and built for the modern automotive industry.
              </p>
            </div>
            <div>
              <h3 className="text-white font-semibold mb-4">Product</h3>
              <ul className="space-y-2 text-gray-400">
                <li><a href="#" className="hover:text-white transition-colors">Features</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Pricing</a></li>
                <li><a href="#" className="hover:text-white transition-colors">API</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Integrations</a></li>
              </ul>
            </div>
            <div>
              <h3 className="text-white font-semibold mb-4">Company</h3>
              <ul className="space-y-2 text-gray-400">
                <li><a href="#" className="hover:text-white transition-colors">About</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Contact</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Support</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Privacy</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-white/10 mt-8 pt-8 text-center">
            <p className="text-gray-400">© 2025 MOS Maintenance. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
