import React from "react";

export default function DocsPage() {
  return (
    <iframe
      src="/api/docs/ui"
      style={{
        width: "100%",
        height: "100vh",
        border: "none",
        display: "block",
      }}
      title="API Documentation"
    />
  );
}
