"use client";

import { useState, useEffect } from "react";
import { Database, Search, RefreshCw, ChevronDown, ChevronRight, Loader2, Copy, Check } from "lucide-react";

interface CollectionInfo {
  name: string;
  count: number;
}

interface QueryResult {
  documents: any[];
  totalCount: number;
  executionTime: number;
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

  useEffect(() => {
    fetchCollections();
  }, []);

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
    queryCollection(name);
  };

  const copyDocument = (doc: any, index: number) => {
    navigator.clipboard.writeText(JSON.stringify(doc, null, 2));
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  };

  const filteredCollections = collections.filter(c => 
    c.name.toLowerCase().includes(collectionSearch.toLowerCase())
  );

  const formatValue = (value: any): string => {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "object") {
      if (value.$date) return new Date(value.$date).toLocaleString();
      if (value.$oid) return value.$oid;
      return JSON.stringify(value);
    }
    return String(value);
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Database className="w-8 h-8 text-purple-600" />
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Database Explorer</h1>
            <p className="text-slate-500 text-sm">Browse and query MongoDB collections</p>
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
                className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
          </div>
          <div className="max-h-[600px] overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-purple-600" />
              </div>
            ) : (
              <ul>
                {filteredCollections.map((coll) => (
                  <li key={coll.name}>
                    <button
                      onClick={() => selectCollection(coll.name)}
                      className={`w-full flex items-center justify-between px-4 py-3 text-left text-sm hover:bg-slate-50 transition-colors ${
                        selectedCollection === coll.name ? "bg-purple-50 text-purple-700 border-r-2 border-purple-600" : "text-slate-700"
                      }`}
                    >
                      <span className="font-medium truncate">{coll.name}</span>
                      <span className="text-xs text-slate-400 ml-2">{coll.count.toLocaleString()}</span>
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
                  {queryResult && (
                    <span className="text-xs text-slate-500">
                      {queryResult.totalCount.toLocaleString()} documents ({queryResult.executionTime}ms)
                    </span>
                  )}
                </div>
                
                <div className="grid grid-cols-12 gap-3">
                  <div className="col-span-6">
                    <label className="block text-xs font-medium text-slate-500 mb-1">Filter (JSON)</label>
                    <input
                      type="text"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder='{"field": "value"}'
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-medium text-slate-500 mb-1">Sort Field</label>
                    <input
                      type="text"
                      value={sortField}
                      onChange={(e) => setSortField(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                  <div className="col-span-1">
                    <label className="block text-xs font-medium text-slate-500 mb-1">Order</label>
                    <select
                      value={sortOrder}
                      onChange={(e) => setSortOrder(e.target.value as "asc" | "desc")}
                      className="w-full px-2 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
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
                      className="w-full px-2 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                  <div className="col-span-1">
                    <label className="block text-xs font-medium text-slate-500 mb-1">Skip</label>
                    <input
                      type="number"
                      value={skip}
                      onChange={(e) => setSkip(Number(e.target.value))}
                      min={0}
                      className="w-full px-2 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                    />
                  </div>
                  <div className="col-span-1 flex items-end">
                    <button
                      onClick={() => queryCollection()}
                      disabled={queryLoading}
                      className="w-full px-3 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-1"
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

              <div className="max-h-[500px] overflow-y-auto">
                {queryLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 animate-spin text-purple-600" />
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
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              copyDocument(doc, idx);
                            }}
                            className="p-1 hover:bg-slate-200 rounded transition-colors"
                          >
                            {copiedIndex === idx ? (
                              <Check className="w-4 h-4 text-green-500" />
                            ) : (
                              <Copy className="w-4 h-4 text-slate-400" />
                            )}
                          </button>
                        </div>
                        {expandedDoc === idx && (
                          <div className="px-4 pb-4 pl-16">
                            <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg overflow-x-auto text-xs font-mono">
                              {JSON.stringify(doc, null, 2)}
                            </pre>
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
