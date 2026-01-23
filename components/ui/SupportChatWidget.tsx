"use client";

import { useState, useEffect } from "react";
import { MessageCircle, X, Send, Loader2, ArrowRight, ThumbsUp, Monitor, Copy, Check } from "lucide-react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

declare global {
  interface Window {
    CobrowseIO: any;
  }
}

export default function SupportChatWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showEscalate, setShowEscalate] = useState(false);
  const [screenShareCode, setScreenShareCode] = useState<string | null>(null);
  const [screenShareLoading, setScreenShareLoading] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);

  useEffect(() => {
    if (isOpen && messages.length === 0) {
      fetchSession();
    }
  }, [isOpen]);

  useEffect(() => {
    const el = document.getElementById("chat-messages-end");
    if (el) el.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const fetchSession = async () => {
    try {
      const res = await fetch("/api/support/chat");
      const data = await res.json();
      if (data.ok) {
        setSessionId(data.session.sessionId);
        setMessages(data.session.messages || []);
      }
    } catch (error) {
      console.error("Failed to fetch chat session:", error);
    }
  };

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput("");
    setMessages(prev => [...prev, { 
      role: "user", 
      content: userMessage, 
      timestamp: new Date().toISOString() 
    }]);
    setIsLoading(true);

    try {
      const res = await fetch("/api/support/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage })
      });
      const data = await res.json();
      
      if (data.ok) {
        setSessionId(data.sessionId);
        setMessages(prev => [...prev, { 
          role: "assistant", 
          content: data.response, 
          timestamp: new Date().toISOString() 
        }]);
        
        if (messages.length >= 4) {
          setShowEscalate(true);
        }
      }
    } catch (error) {
      setMessages(prev => [...prev, { 
        role: "assistant", 
        content: "I'm having trouble connecting. Would you like to create a support ticket?", 
        timestamp: new Date().toISOString() 
      }]);
      setShowEscalate(true);
    } finally {
      setIsLoading(false);
    }
  };

  const escalateToTicket = async () => {
    if (!sessionId) return;
    
    setIsLoading(true);
    try {
      const res = await fetch("/api/support/chat/escalate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          sessionId,
          subject: "Escalated from AI Chat Support"
        })
      });
      const data = await res.json();
      
      if (data.ok) {
        setMessages(prev => [...prev, { 
          role: "assistant", 
          content: `I've created support ticket ${data.ticketNumber} for you. Our team will review your conversation and get back to you soon. You can view your ticket in the Support section.`, 
          timestamp: new Date().toISOString() 
        }]);
        setShowEscalate(false);
      }
    } catch (error) {
      console.error("Failed to escalate:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const resolveChat = async () => {
    if (!sessionId) return;
    
    try {
      await fetch("/api/support/chat/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId })
      });
      
      setMessages([]);
      setSessionId(null);
      setShowEscalate(false);
      setIsOpen(false);
    } catch (error) {
      console.error("Failed to resolve chat:", error);
    }
  };

  const handleKeyPress = (e: any) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const startScreenShare = async () => {
    setScreenShareLoading(true);
    try {
      const res = await fetch("/api/cobrowse/config");
      const data = await res.json();
      
      if (!data.licenseKey) {
        setMessages(prev => [...prev, {
          role: "assistant",
          content: "Screen sharing is not available at this time.",
          timestamp: new Date().toISOString()
        }]);
        setScreenShareLoading(false);
        return;
      }

      if (!window.CobrowseIO) {
        const script = document.createElement("script");
        script.src = "https://js.cobrowse.io/CobrowseIO.js";
        script.async = true;
        script.crossOrigin = "anonymous";
        
        await new Promise<void>((resolve, reject) => {
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("Failed to load screen sharing"));
          document.head.appendChild(script);
        });
      }

      window.CobrowseIO.license = data.licenseKey;
      
      await window.CobrowseIO.client();
      await window.CobrowseIO.start();
      
      await new Promise(resolve => setTimeout(resolve, 500));

      const code = await window.CobrowseIO.createSessionCode();
      setScreenShareCode(code);
    } catch (err: any) {
      console.error("Screen share error:", err);
      setMessages(prev => [...prev, {
        role: "assistant",
        content: "Unable to start screen sharing. Please try again or contact support.",
        timestamp: new Date().toISOString()
      }]);
    } finally {
      setScreenShareLoading(false);
    }
  };

  const endScreenShare = () => {
    if (window.CobrowseIO?.currentSession) {
      window.CobrowseIO.currentSession.end();
    }
    setScreenShareCode(null);
  };

  const copyCode = () => {
    if (screenShareCode) {
      navigator.clipboard.writeText(screenShareCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    }
  };

  return (
    <>
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 w-14 h-14 bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-lg flex items-center justify-center transition-all z-50"
          title="AI Support Chat"
        >
          <MessageCircle className="w-6 h-6" />
        </button>
      )}

      {isOpen && (
        <div className="fixed bottom-6 right-6 w-96 h-[500px] bg-white rounded-lg shadow-2xl flex flex-col z-50 border border-gray-200">
          <div className="bg-blue-600 text-white px-4 py-3 rounded-t-lg flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessageCircle className="w-5 h-5" />
              <span className="font-medium">AI Support</span>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-white/80 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-center text-gray-500 mt-8">
                <MessageCircle className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p className="text-sm">Hi! I'm your AI support assistant.</p>
                <p className="text-sm">How can I help you today?</p>
              </div>
            )}
            
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-800"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-gray-100 px-4 py-2 rounded-lg">
                  <Loader2 className="w-4 h-4 animate-spin text-gray-500" />
                </div>
              </div>
            )}
            
            <div id="chat-messages-end" />
          </div>

          {showEscalate && (
            <div className="px-4 py-2 bg-yellow-50 border-t border-yellow-100 flex items-center justify-between">
              <span className="text-xs text-yellow-700">Need more help?</span>
              <button
                onClick={escalateToTicket}
                disabled={isLoading}
                className="text-xs bg-yellow-600 hover:bg-yellow-700 text-white px-3 py-1 rounded flex items-center gap-1"
              >
                Create Ticket <ArrowRight className="w-3 h-3" />
              </button>
            </div>
          )}

          {screenShareCode && (
            <div className="px-4 py-3 bg-green-50 border-t border-green-200">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-green-700 flex items-center gap-1">
                  <Monitor className="w-3 h-3" /> Screen Share Ready
                </span>
                <button onClick={endScreenShare} className="text-xs text-green-600 hover:text-green-800">
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-white border border-green-300 rounded px-2 py-1 text-center">
                  <span className="font-mono font-bold text-green-800 tracking-wider">{screenShareCode}</span>
                </div>
                <button onClick={copyCode} className="p-1 bg-green-600 text-white rounded hover:bg-green-700">
                  {codeCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-green-600 mt-1">Share this code with support</p>
            </div>
          )}

          {messages.length > 0 && (
            <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={resolveChat}
                  className="text-xs text-green-600 hover:text-green-700 flex items-center gap-1"
                >
                  <ThumbsUp className="w-3 h-3" /> Resolved
                </button>
                {!screenShareCode && (
                  <button
                    onClick={startScreenShare}
                    disabled={screenShareLoading}
                    className="text-xs text-purple-600 hover:text-purple-700 flex items-center gap-1"
                  >
                    <Monitor className="w-3 h-3" /> {screenShareLoading ? "Loading..." : "Share Screen"}
                  </button>
                )}
              </div>
              <button
                onClick={escalateToTicket}
                disabled={isLoading}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Talk to a human
              </button>
            </div>
          )}

          <div className="p-3 border-t border-gray-200">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type your question..."
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                disabled={isLoading}
              />
              <button
                onClick={sendMessage}
                disabled={isLoading || !input.trim()}
                className="px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded-lg transition-colors"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
