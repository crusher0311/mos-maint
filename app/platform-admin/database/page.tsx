"use client";

import { useState, useEffect } from "react";
import { Database, Search, RefreshCw, ChevronDown, ChevronRight, Loader2, Copy, Check, Plus, Pencil, Trash2, X, Save, AlertTriangle } from "lucide-react";

interface CollectionInfo {
  name: string;
  count: number;
}

interface QueryResult {
  documents: any[];
  totalCount: number;
  executionTime: number;
}

interface Permissions {
  canRead: boolean;
  canWrite: boolean;
  email: string;
}

export default function PlatformDatabasePage() {
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [filter, setFilter] = useState("{}");
  const [limit, setLimit] = useState(20);
  const [skip, setSkip] = useState(0);
  const [sortField, setSortField] = useState("_id");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [expandedDoc, setExpandedDoc] = useState<number | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [collectionSearch, setCollectionSearch] = useState("");
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [editingDoc, setEditingDoc] = useState<{ index: number; content: string } | null>(null);
  const [insertDoc, setInsertDoc] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ index: number; id: string } | null>(null);
  const [writeLoading, setWriteLoading] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [writeSuccess, setWriteSuccess] = useState<string | null>(null);

  useEffect(() => {
    fetchCollections();
    fetchPermissions();
  }, []);

  const fetchPermissions = async () => {
    try {
      const res = await fetch("/api/admin/database/permissions");
      if (res.ok) {
        const data = await res.json();
        setPermissions(data);
      }
    } catch (err) {
      console.error("Failed to fetch permissions:", err);
    }
  };

  const fetchCollections = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/database/collections");
      if (res.ok) {
        const data = await res.json();
        setCollections(data.collections || []);
      }
    } catch (err) {
      console.error("Failed to fetch collections:", err);
    } finally {
      setLoading(false);
    }
  };

  const queryCollection = async (collName?: string) => {
    const collection = collName || selectedCollection;
    if (!collection) return;

    setQueryLoading(true);
    try {
      let parsedFilter = {};
      try {
        parsedFilter = JSON.parse(filter);
      } catch {
        parsedFilter = {};
      }

      const res = await fetch("/api/admin/database/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collection,
          filter: parsedFilter,
          limit,
          skip,
          sort: { [sortField]: sortOrder === "asc" ? 1 : -1 }
        })
      });

      if (res.ok) {
        const data = await res.json();
        setQueryResult(data);
      }
    } catch (err) {
      console.error("Query failed:", err);
    } finally {
      setQueryLoading(false);
    }
  };

  const selectCollection = (name: string) => {
    setSelectedCollection(name);
    setFilter("{}");
    setSkip(0);
    setExpandedDoc(null);
    setEditingDoc(null);
    setInsertDoc(null);
    setDeleteConfirm(null);
    queryCollection(name);
  };

  const copyDocument = (doc: any, index: number) => {
    navigator.clipboard.writeText(JSON.stringify(doc, null, 2));
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const handleInsert = async () => {
    if (!selectedCollection || !insertDoc) return;
    
    setWriteLoading(true);
    setWriteError(null);
    try {
      const parsedDoc = JSON.parse(insertDoc);
      const res = await fetch("/api/admin/database/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "insert",
          collection: selectedCollection,
          document: parsedDoc
        })
      });

      const data = await res.json();
      if (!res.ok) {
        setWriteError(data.error || "Insert failed");
      } else {
        setWriteSuccess("Document inserted successfully");
        setInsertDoc(null);
        queryCollection();
        setTimeout(() => setWriteSuccess(null), 3000);
      }
    } catch (err: any) {
      setWriteError(err.message || "Invalid JSON");
    } finally {
      setWriteLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!selectedCollection || !editingDoc || !queryResult) return;
    
    const doc = queryResult.documents[editingDoc.index];
    const docId = doc._id?.$oid || doc._id;
    
    setWriteLoading(true);
    setWriteError(null);
    try {
      const parsedDoc = JSON.parse(editingDoc.content);
      const res = await fetch("/api/admin/database/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          collection: selectedCollection,
          documentId: docId,
          document: parsedDoc
        })
      });

      const data = await res.json();
      if (!res.ok) {
        setWriteError(data.error || "Update failed");
      } else {
        setWriteSuccess("Document updated successfully");
        setEditingDoc(null);
        queryCollection();
        setTimeout(() => setWriteSuccess(null), 3000);
      }
    } catch (err: any) {
      setWriteError(err.message || "Invalid JSON");
    } finally {
      setWriteLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedCollection || !deleteConfirm) return;
    
    setWriteLoading(true);
    setWriteError(null);
    try {
      const res = await fetch("/api/admin/database/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete",
          collection: selectedCollection,
          documentId: deleteConfirm.id
        })
      });

      const data = await res.json();
      if (!res.ok) {
        setWriteError(data.error || "Delete failed");
      } else {
        setWriteSuccess("Document deleted successfully");
        setDeleteConfirm(null);
        queryCollection();
        setTimeout(() => setWriteSuccess(null), 3000);
      }
    } catch (err: any) {
      setWriteError(err.message || "Delete failed");
    } finally {
      setWriteLoading(false);
    }
  };

  const startEdit = (index: number) => {
    if (!queryResult) return;
    const doc = queryResult.documents[index];
    setEditingDoc({ index, content: JSON.stringify(doc, null, 2) });
    setExpandedDoc(index);
  };

  const filteredCollections = collections.filter(c => 
    c.name.toLowerCase().includes(collectionSearch.toLowerCase())
  );

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Database className="w-8 h-8 text-mos-blue" />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Database Explorer</h1>
            <p className="text-slate-500 text-sm">
              Browse and query MongoDB collections
              {permissions?.canWrite && (
                <span className="ml-2 text-green-600 font-medium">(Write access enabled)</span>
              )}
            </p>
          </div>
        </div>
        <button
          onClick={fetchCollections}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-slate-100 hover:bg-slate-200 rounded-lg text-sm font-medium transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {(writeError || writeSuccess) && (
        <div className={`mb-4 p-3 rounded-lg ${writeError ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"}`}>
          {writeError || writeSuccess}
        </div>
      )}

      <div className="grid grid-cols-12 gap-6">
        <div className="col-span-3 bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="p-4 border-b border-slate-200">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder="Search collections..."
                value={collectionSearch}
                onChange={(e) => setCollectionSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-mos-blue"
              />
            </div>
          </div>
          <div className="max-h-[600px] overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-mos-blue" />
              </div>
            ) : (
              <ul>
                {filteredCollections.map((coll) => (
                  <li key={coll.name}>
                    <button
                      onClick={() => selectCollection(coll.name)}
                      className={`w-full flex items-center justify-between px-4 py-3 text-left text-sm hover:bg-slate-50 transition-colors ${
                        selectedCollection === coll.name ? "bg-blue-50 text-blue-700 border-r-2 border-mos-blue" : "text-slate-700"
                      }`}
                    >
                      <span className="font-medium truncate">{coll.name}</span>
                      {coll.count !== null && <span className="text-xs text-slate-400 ml-2">{coll.count.toLocaleString()}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="col-span-9">
          {selectedCollection ? (
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="p-4 border-b border-slate-200">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-slate-900">{selectedCollection}</h2>
                  <div className="flex items-center gap-3">
                    {permissions?.canWrite && (
                      <button
                        onClick={() => setInsertDoc("{}")}
                        className="flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition-colors"
                      >
                        <Plus className="w-4 h-4" />
                        Insert
                      </button>
                    )}
                    {queryResult && (
                      <span className="text-xs text-slate-500">
                        {queryResult.totalCount.toLocaleString()} documents ({queryResult.executionTime}ms)
                      </span>
                    )}
                  </div>
                </div>
                
                <div className="grid grid-cols-12 gap-3">
                  <div className="col-span-6">
                    <label className="block text-xs font-medium text-slate-500 mb-1">Filter (JSON)</label>
                    <input
                      type="text"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder='{"field": "value"}'
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-mos-blue"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-slate-500 mb-1">Sort Field</label>
                    <input
                      type="text"
                      value={sortField}
                      onChange={(e) => setSortField(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-mos-blue"
                    />
                  </div>
                  <div className="col-span-1">
                    <label className="block text-xs font-medium text-slate-500 mb-1">Order</label>
                    <select
                      value={sortOrder}
                      onChange={(e) => setSortOrder(e.target.value as "asc" | "desc")}
                      className="w-full px-2 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-mos-blue"
                    >
                      <option value="desc">Desc</option>
                      <option value="asc">Asc</option>
                    </select>
                  </div>
                  <div className="col-span-1">
                    <label className="block text-xs font-medium text-slate-500 mb-1">Limit</label>
                    <input
                      type="number"
                      value={limit}
                      onChange={(e) => setLimit(Number(e.target.value))}
                      min={1}
                      max={100}
                      className="w-full px-2 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-mos-blue"
                    />
                  </div>
                  <div className="col-span-1">
                    <label className="block text-xs font-medium text-slate-500 mb-1">Skip</label>
                    <input
                      type="number"
                      value={skip}
                      onChange={(e) => setSkip(Number(e.target.value))}
                      min={0}
                      className="w-full px-2 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-mos-blue"
                    />
                  </div>
                  <div className="col-span-1 flex items-end">
                    <button
                      onClick={() => queryCollection()}
                      disabled={queryLoading}
                      className="w-full px-3 py-2 bg-mos-blue hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-1"
                    >
                      {queryLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Search className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {insertDoc !== null && (
                <div className="p-4 border-b border-slate-200 bg-green-50">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-medium text-green-800">Insert New Document</h3>
                    <button onClick={() => setInsertDoc(null)} className="text-slate-400 hover:text-slate-600">
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                  <textarea
                    value={insertDoc}
                    onChange={(e) => setInsertDoc(e.target.value)}
                    rows={8}
                    className="w-full px-3 py-2 border border-green-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                    placeholder='{"field": "value"}'
                  />
                  <div className="flex justify-end gap-2 mt-2">
                    <button
                      onClick={() => setInsertDoc(null)}
                      className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleInsert}
                      disabled={writeLoading}
                      className="flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      {writeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                      Insert
                    </button>
                  </div>
                </div>
              )}

              {deleteConfirm && (
                <div className="p-4 border-b border-slate-200 bg-red-50">
                  <div className="flex items-center gap-3">
                    <AlertTriangle className="w-5 h-5 text-red-600" />
                    <div className="flex-1">
                      <p className="font-medium text-red-800">Confirm Delete</p>
                      <p className="text-sm text-red-600">Are you sure you want to delete document {deleteConfirm.id}?</p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setDeleteConfirm(null)}
                        className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm bg-white"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleDelete}
                        disabled={writeLoading}
                        className="flex items-center gap-1 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium transition-colors"
                      >
                        {writeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              )}

              <div className="max-h-[500px] overflow-y-auto">
                {queryLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 animate-spin text-mos-blue" />
                  </div>
                ) : queryResult?.documents.length ? (
                  <div className="divide-y divide-slate-100">
                    {queryResult.documents.map((doc, idx) => (
                      <div key={idx} className="hover:bg-slate-50">
                        <div
                          className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                          onClick={() => setExpandedDoc(expandedDoc === idx ? null : idx)}
                        >
                          {expandedDoc === idx ? (
                            <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
                          )}
                          <span className="text-xs font-mono text-slate-500 w-8">{skip + idx + 1}</span>
                          <span className="text-sm text-slate-600 truncate flex-1 font-mono">
                            {doc._id?.$oid || doc._id || "no _id"}
                          </span>
                          <div className="flex items-center gap-1">
                            {permissions?.canWrite && (
                              <>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    startEdit(idx);
                                  }}
                                  className="p-1 hover:bg-blue-100 rounded transition-colors"
                                  title="Edit document"
                                >
                                  <Pencil className="w-4 h-4 text-blue-500" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setDeleteConfirm({ index: idx, id: doc._id?.$oid || doc._id });
                                  }}
                                  className="p-1 hover:bg-red-100 rounded transition-colors"
                                  title="Delete document"
                                >
                                  <Trash2 className="w-4 h-4 text-red-500" />
                                </button>
                              </>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                copyDocument(doc, idx);
                              }}
                              className="p-1 hover:bg-slate-200 rounded transition-colors"
                              title="Copy document"
                            >
                              {copiedIndex === idx ? (
                                <Check className="w-4 h-4 text-green-500" />
                              ) : (
                                <Copy className="w-4 h-4 text-slate-400" />
                              )}
                            </button>
                          </div>
                        </div>
                        {expandedDoc === idx && (
                          <div className="px-4 pb-4 pl-16">
                            {editingDoc?.index === idx ? (
                              <div>
                                <textarea
                                  value={editingDoc.content}
                                  onChange={(e) => setEditingDoc({ ...editingDoc, content: e.target.value })}
                                  rows={12}
                                  className="w-full px-3 py-2 border border-blue-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                                />
                                <div className="flex justify-end gap-2 mt-2">
                                  <button
                                    onClick={() => setEditingDoc(null)}
                                    className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    onClick={handleUpdate}
                                    disabled={writeLoading}
                                    className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
                                  >
                                    {writeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                                    Save Changes
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg overflow-x-auto text-xs font-mono">
                                {JSON.stringify(doc, null, 2)}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-12 text-slate-500">
                    No documents found
                  </div>
                )}
              </div>

              {queryResult && queryResult.totalCount > limit && (
                <div className="p-4 border-t border-slate-200 flex items-center justify-between">
                  <span className="text-sm text-slate-500">
                    Showing {skip + 1}-{Math.min(skip + limit, queryResult.totalCount)} of {queryResult.totalCount.toLocaleString()}
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setSkip(Math.max(0, skip - limit));
                        setTimeout(() => queryCollection(), 0);
                      }}
                      disabled={skip === 0}
                      className="px-3 py-1 border border-slate-200 rounded text-sm disabled:opacity-50"
                    >
                      Previous
                    </button>
                    <button
                      onClick={() => {
                        setSkip(skip + limit);
                        setTimeout(() => queryCollection(), 0);
                      }}
                      disabled={skip + limit >= queryResult.totalCount}
                      className="px-3 py-1 border border-slate-200 rounded text-sm disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 p-12 flex flex-col items-center justify-center text-slate-500">
              <Database className="w-12 h-12 text-slate-300 mb-4" />
              <p>Select a collection to browse documents</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
