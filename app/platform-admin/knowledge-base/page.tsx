"use client";

import { useState, useEffect } from "react";
import {
  BookOpen,
  Plus,
  Search,
  Edit2,
  Trash2,
  Eye,
  ThumbsUp,
  Tag,
  FolderOpen,
  X,
  Save,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface KnowledgeArticle {
  _id: string;
  title: string;
  problem: string;
  solution: string;
  category: string;
  tags: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  viewCount: number;
  helpfulCount: number;
}

export default function KnowledgeBasePage() {
  const [articles, setArticles] = useState<KnowledgeArticle[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [editingArticle, setEditingArticle] = useState<KnowledgeArticle | null>(null);
  const [expandedArticle, setExpandedArticle] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    title: "",
    problem: "",
    solution: "",
    category: "",
    tags: "",
  });

  useEffect(() => {
    fetchArticles();
  }, []);

  async function fetchArticles() {
    setLoading(true);
    try {
      const res = await fetch("/api/platform-admin/knowledge-base");
      const data = await res.json();
      if (data.ok) {
        setArticles(data.articles || []);
        setCategories(data.categories || []);
      }
    } catch (err) {
      console.error("Error fetching articles:", err);
    }
    setLoading(false);
  }

  async function handleSearch() {
    if (!searchQuery.trim()) {
      fetchArticles();
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/platform-admin/knowledge-base?query=${encodeURIComponent(searchQuery)}`);
      const data = await res.json();
      if (data.ok) {
        setArticles(data.articles || []);
      }
    } catch (err) {
      console.error("Error searching:", err);
    }
    setLoading(false);
  }

  function openEditor(article?: KnowledgeArticle) {
    if (article) {
      setEditingArticle(article);
      setFormData({
        title: article.title,
        problem: article.problem,
        solution: article.solution,
        category: article.category,
        tags: article.tags.join(", "),
      });
    } else {
      setEditingArticle(null);
      setFormData({ title: "", problem: "", solution: "", category: "", tags: "" });
    }
    setShowEditor(true);
  }

  async function handleSave() {
    if (!formData.title || !formData.problem || !formData.solution) return;
    setSaving(true);

    const payload = {
      title: formData.title,
      problem: formData.problem,
      solution: formData.solution,
      category: formData.category || "General",
      tags: formData.tags.split(",").map((t) => t.trim()).filter(Boolean),
    };

    try {
      let res: Response;
      if (editingArticle) {
        res = await fetch(`/api/platform-admin/knowledge-base/${editingArticle._id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetch("/api/platform-admin/knowledge-base", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      const data = await res.json();
      if (!data.ok) {
        alert(data.error || "Failed to save article");
      } else {
        setShowEditor(false);
        fetchArticles();
      }
    } catch (err) {
      console.error("Error saving:", err);
      alert("Failed to save article. Please try again.");
    }
    setSaving(false);
  }

  async function handleDelete(id: string) {
    try {
      await fetch(`/api/platform-admin/knowledge-base/${id}`, { method: "DELETE" });
      setDeleteConfirm(null);
      fetchArticles();
    } catch (err) {
      console.error("Error deleting:", err);
    }
  }

  const filteredArticles = selectedCategory
    ? articles.filter((a) => a.category === selectedCategory)
    : articles;

  const groupedByCategory = filteredArticles.reduce((acc, article) => {
    const cat = article.category || "General";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(article);
    return acc;
  }, {} as Record<string, KnowledgeArticle[]>);

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <BookOpen className="w-7 h-7 text-blue-600" />
            Knowledge Base
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            {articles.length} articles across {categories.length} categories
          </p>
        </div>
        <button
          onClick={() => openEditor()}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          New Article
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search articles..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        <button
          onClick={handleSearch}
          className="px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors text-sm font-medium"
        >
          Search
        </button>
        {searchQuery && (
          <button
            onClick={() => { setSearchQuery(""); fetchArticles(); }}
            className="px-4 py-2.5 text-gray-500 hover:text-gray-700 text-sm"
          >
            Clear
          </button>
        )}
      </div>

      {categories.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
              !selectedCategory
                ? "bg-blue-100 text-blue-700"
                : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            All ({articles.length})
          </button>
          {categories.sort().map((cat) => {
            const count = articles.filter((a) => a.category === cat).length;
            return (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat === selectedCategory ? null : cat)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                  selectedCategory === cat
                    ? "bg-blue-100 text-blue-700"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {cat} ({count})
              </button>
            );
          })}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-400">Loading articles...</div>
      ) : filteredArticles.length === 0 ? (
        <div className="text-center py-12">
          <BookOpen className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No articles found</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(groupedByCategory)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([category, catArticles]) => (
              <div key={category}>
                <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <FolderOpen className="w-4 h-4" />
                  {category}
                  <span className="text-xs font-normal text-gray-400">({catArticles.length})</span>
                </h2>
                <div className="space-y-2">
                  {catArticles.map((article) => (
                    <div
                      key={article._id}
                      className="bg-white border border-gray-200 rounded-lg overflow-hidden"
                    >
                      <div
                        className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors"
                        onClick={() =>
                          setExpandedArticle(
                            expandedArticle === article._id ? null : article._id
                          )
                        }
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          {expandedArticle === article._id ? (
                            <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
                          )}
                          <h3 className="font-medium text-gray-900 text-sm truncate">
                            {article.title}
                          </h3>
                        </div>
                        <div className="flex items-center gap-3 ml-4 flex-shrink-0">
                          <span className="flex items-center gap-1 text-xs text-gray-400">
                            <Eye className="w-3 h-3" />
                            {article.viewCount}
                          </span>
                          <span className="flex items-center gap-1 text-xs text-gray-400">
                            <ThumbsUp className="w-3 h-3" />
                            {article.helpfulCount}
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); openEditor(article); }}
                            className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                            title="Edit"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          {deleteConfirm === article._id ? (
                            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                              <button
                                onClick={() => handleDelete(article._id)}
                                className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setDeleteConfirm(null)}
                                className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); setDeleteConfirm(article._id); }}
                              className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                              title="Delete"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>

                      {expandedArticle === article._id && (
                        <div className="px-4 pb-4 border-t border-gray-100">
                          <div className="mt-3 space-y-3">
                            <div>
                              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Problem</h4>
                              <p className="text-sm text-gray-700">{article.problem}</p>
                            </div>
                            <div>
                              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-1">Solution</h4>
                              <div className="text-sm text-gray-700 whitespace-pre-wrap">{article.solution}</div>
                            </div>
                            {article.tags.length > 0 && (
                              <div className="flex items-center gap-2 flex-wrap">
                                <Tag className="w-3 h-3 text-gray-400" />
                                {article.tags.map((tag) => (
                                  <span
                                    key={tag}
                                    className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs"
                                  >
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="flex items-center gap-4 text-xs text-gray-400 pt-1">
                              <span>Created by: {article.createdBy}</span>
                              <span>Updated: {new Date(article.updatedAt).toLocaleDateString()}</span>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}

      {showEditor && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">
                {editingArticle ? "Edit Article" : "New Article"}
              </h2>
              <button
                onClick={() => setShowEditor(false)}
                className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                <input
                  type="text"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Article title"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                <input
                  type="text"
                  value={formData.category}
                  onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g. Getting Started, Chrome Extension, Vehicle Health Intelligence"
                  list="categories-list"
                />
                <datalist id="categories-list">
                  {categories.map((cat) => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Problem / Question</label>
                <textarea
                  value={formData.problem}
                  onChange={(e) => setFormData({ ...formData, problem: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                  rows={3}
                  placeholder="What problem or question does this article address?"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Solution / Answer</label>
                <textarea
                  value={formData.solution}
                  onChange={(e) => setFormData({ ...formData, solution: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                  rows={8}
                  placeholder="Provide the solution or answer. Use **bold** for emphasis and numbered lists for steps."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Tags (comma-separated)</label>
                <input
                  type="text"
                  value={formData.tags}
                  onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g. setup, extension, tekmetric"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 p-4 border-t border-gray-200">
              <button
                onClick={() => setShowEditor(false)}
                className="px-4 py-2 text-gray-600 hover:text-gray-800 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !formData.title || !formData.problem || !formData.solution}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save className="w-4 h-4" />
                {saving ? "Saving..." : editingArticle ? "Update Article" : "Create Article"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
