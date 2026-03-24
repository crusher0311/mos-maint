"use client";

import { useState, useEffect } from "react";
import { Plus, GripVertical, MapPin, User, Clock, ChevronRight, Loader2, RefreshCw, X } from "lucide-react";

interface Stage {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  sortOrder: number;
}

interface CardData {
  card: {
    id: string;
    locationId: string;
    stageId: string;
    assigneeEmail: string | null;
    assigneeName: string | null;
    notes: string | null;
    priority: string | null;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  };
  location: { id: string; name: string; city: string | null; state: string | null };
  stage: Stage;
  account: { id: string; name: string } | null;
}

export default function OnboardingBoardPage() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [cards, setCards] = useState<CardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddCard, setShowAddCard] = useState(false);
  const [locations, setLocations] = useState<any[]>([]);
  const [selectedCard, setSelectedCard] = useState<CardData | null>(null);
  const [saving, setSaving] = useState(false);
  const [newCard, setNewCard] = useState({ locationId: "", stageId: "", assigneeName: "", notes: "", priority: "normal" });

  const loadData = async () => {
    setLoading(true);
    try {
      const [stagesRes, cardsRes] = await Promise.all([
        fetch("/api/platform-admin/onboarding/stages"),
        fetch("/api/platform-admin/onboarding/cards"),
      ]);
      const stagesData = await stagesRes.json();
      const cardsData = await cardsRes.json();
      if (stagesData.ok) setStages(stagesData.stages);
      if (cardsData.ok) setCards(cardsData.cards);
    } catch (error) {
      console.error("Error loading onboarding data:", error);
    }
    setLoading(false);
  };

  const loadLocations = async () => {
    try {
      const res = await fetch("/api/platform-admin/crm/locations");
      const data = await res.json();
      if (data.ok) setLocations(data.locations || []);
    } catch (error) {
      console.error("Error loading locations:", error);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleCreateCard = async () => {
    if (!newCard.locationId || !newCard.stageId) return;
    setSaving(true);
    try {
      const res = await fetch("/api/platform-admin/onboarding/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newCard),
      });
      if ((await res.json()).ok) {
        setShowAddCard(false);
        setNewCard({ locationId: "", stageId: "", assigneeName: "", notes: "", priority: "normal" });
        loadData();
      }
    } catch (error) {
      console.error("Error creating card:", error);
    }
    setSaving(false);
  };

  const handleMoveCard = async (cardId: string, newStageId: string) => {
    try {
      const res = await fetch(`/api/platform-admin/onboarding/cards/${cardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stageId: newStageId }),
      });
      if ((await res.json()).ok) loadData();
    } catch (error) {
      console.error("Error moving card:", error);
    }
  };

  const handleDeleteCard = async (cardId: string) => {
    if (!confirm("Delete this onboarding card?")) return;
    try {
      await fetch(`/api/platform-admin/onboarding/cards/${cardId}`, { method: "DELETE" });
      setSelectedCard(null);
      loadData();
    } catch (error) {
      console.error("Error deleting card:", error);
    }
  };

  const getCardsByStage = (stageId: string) => cards.filter(c => c.card.stageId === stageId);

  const priorityColors: Record<string, string> = {
    high: "border-l-red-500",
    normal: "border-l-blue-500",
    low: "border-l-gray-400",
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Onboarding Board</h1>
          <p className="text-gray-500 mt-1">Track locations through onboarding stages</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={loadData} className="flex items-center gap-2 px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
          <button
            onClick={() => { setShowAddCard(true); loadLocations(); }}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus className="w-4 h-4" /> Add Card
          </button>
        </div>
      </div>

      {stages.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
          <p className="text-gray-500 mb-4">No onboarding stages configured yet.</p>
          <a href="/platform-admin/onboarding/stages" className="text-blue-600 hover:text-blue-700 font-medium">
            Configure Stages →
          </a>
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: "60vh" }}>
          {stages.map(stage => {
            const stageCards = getCardsByStage(stage.id);
            return (
              <div key={stage.id} className="flex-shrink-0 w-80 bg-gray-50 rounded-xl border border-gray-200">
                <div className="p-4 border-b border-gray-200" style={{ borderTopColor: stage.color || "#3c81c3", borderTopWidth: 3, borderTopStyle: "solid", borderRadius: "12px 12px 0 0" }}>
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-gray-900">{stage.name}</h3>
                    <span className="px-2 py-0.5 text-xs font-medium bg-gray-200 text-gray-700 rounded-full">
                      {stageCards.length}
                    </span>
                  </div>
                  {stage.description && <p className="text-xs text-gray-500 mt-1">{stage.description}</p>}
                </div>

                <div className="p-3 space-y-3 min-h-[200px]"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const cardId = e.dataTransfer.getData("cardId");
                    if (cardId) handleMoveCard(cardId, stage.id);
                  }}
                >
                  {stageCards.map(cardData => (
                    <div
                      key={cardData.card.id}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData("cardId", cardData.card.id)}
                      onClick={() => setSelectedCard(cardData)}
                      className={`bg-white rounded-lg border border-gray-200 p-3 cursor-pointer hover:shadow-md transition-shadow border-l-4 ${priorityColors[cardData.card.priority || "normal"]}`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <h4 className="font-medium text-sm text-gray-900">{cardData.location.name}</h4>
                        <GripVertical className="w-4 h-4 text-gray-400 cursor-grab" />
                      </div>
                      {cardData.account && (
                        <p className="text-xs text-gray-500 mb-1">{cardData.account.name}</p>
                      )}
                      <div className="flex items-center gap-3 text-xs text-gray-400">
                        {cardData.location.city && (
                          <span className="flex items-center gap-1">
                            <MapPin className="w-3 h-3" />
                            {cardData.location.city}, {cardData.location.state}
                          </span>
                        )}
                        {cardData.card.assigneeName && (
                          <span className="flex items-center gap-1">
                            <User className="w-3 h-3" />
                            {cardData.card.assigneeName}
                          </span>
                        )}
                      </div>
                      {cardData.card.notes && (
                        <p className="text-xs text-gray-400 mt-2 line-clamp-2">{cardData.card.notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAddCard && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Add Onboarding Card</h2>
              <button onClick={() => setShowAddCard(false)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Location</label>
                <select value={newCard.locationId} onChange={(e) => setNewCard({ ...newCard, locationId: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2">
                  <option value="">Select location...</option>
                  {locations.map((loc: any) => (
                    <option key={loc.id} value={loc.id}>{loc.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Stage</label>
                <select value={newCard.stageId} onChange={(e) => setNewCard({ ...newCard, stageId: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2">
                  <option value="">Select stage...</option>
                  {stages.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Assignee</label>
                <input value={newCard.assigneeName} onChange={(e) => setNewCard({ ...newCard, assigneeName: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" placeholder="Assignee name..." />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
                <select value={newCard.priority} onChange={(e) => setNewCard({ ...newCard, priority: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2">
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={newCard.notes} onChange={(e) => setNewCard({ ...newCard, notes: e.target.value })} className="w-full border border-gray-300 rounded-lg px-3 py-2" rows={3} placeholder="Optional notes..." />
              </div>
              <div className="flex justify-end gap-3">
                <button onClick={() => setShowAddCard(false)} className="px-4 py-2 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
                <button onClick={handleCreateCard} disabled={saving || !newCard.locationId || !newCard.stageId} className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "Create Card"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {selectedCard && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{selectedCard.location.name}</h2>
              <button onClick={() => setSelectedCard(null)} className="p-1 hover:bg-gray-100 rounded"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-4">
              {selectedCard.account && (
                <div>
                  <span className="text-sm text-gray-500">Account:</span>
                  <span className="ml-2 text-sm font-medium">{selectedCard.account.name}</span>
                </div>
              )}
              <div>
                <span className="text-sm text-gray-500">Stage:</span>
                <span className="ml-2 text-sm font-medium">{selectedCard.stage.name}</span>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Move to Stage</label>
                <select
                  value={selectedCard.card.stageId}
                  onChange={(e) => {
                    handleMoveCard(selectedCard.card.id, e.target.value);
                    setSelectedCard(null);
                  }}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  {stages.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              {selectedCard.card.assigneeName && (
                <div>
                  <span className="text-sm text-gray-500">Assignee:</span>
                  <span className="ml-2 text-sm font-medium">{selectedCard.card.assigneeName}</span>
                </div>
              )}
              {selectedCard.location.city && (
                <div>
                  <span className="text-sm text-gray-500">Location:</span>
                  <span className="ml-2 text-sm font-medium">{selectedCard.location.city}, {selectedCard.location.state}</span>
                </div>
              )}
              {selectedCard.card.notes && (
                <div>
                  <span className="text-sm text-gray-500">Notes:</span>
                  <p className="mt-1 text-sm">{selectedCard.card.notes}</p>
                </div>
              )}
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <Clock className="w-3 h-3" />
                Created {new Date(selectedCard.card.createdAt).toLocaleDateString()}
              </div>
              <div className="flex justify-between pt-4 border-t">
                <button onClick={() => handleDeleteCard(selectedCard.card.id)} className="px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg">Delete Card</button>
                <button onClick={() => setSelectedCard(null)} className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200">Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
