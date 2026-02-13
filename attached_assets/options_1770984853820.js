// options.js

let editingIndex = null;

// SECTION 1: Load and display saved groups
function loadGroups() {
  chrome.storage.local.get(["laborRateGroups"], (data) => {
    const groups = data.laborRateGroups || [];
    const container = document.getElementById("groupsContainer");
    container.innerHTML = "";

    groups.forEach((group, index) => {
      const div = document.createElement("div");
      div.className = "group";
      div.innerHTML = `
        <h3>${group.name}</h3>
        <p><strong>Makes:</strong> ${group.makes.join(", ")}</p>
        <p><strong>Labor Rate:</strong> $${(group.laborRate / 100).toFixed(2)}</p>
        <div class="btn-row">
          <button class="edit-btn" data-index="${index}">Edit</button>
          <button class="remove-btn" data-index="${index}">Remove</button>
        </div>
      `;

      div.querySelector(".edit-btn").addEventListener("click", () => editGroup(index));
      div.querySelector(".remove-btn").addEventListener("click", () => removeGroup(index));
      container.appendChild(div);
    });

    resetForm();
  });
}

// SECTION 2: Save or update group
document.getElementById("saveGroupBtn").addEventListener("click", () => {
  const name = document.getElementById("groupName").value.trim();
  const makes = document.getElementById("makes").value.trim().split(",").map(m => m.trim()).filter(m => m);
  const laborRate = parseFloat(document.getElementById("laborRate").value) * 100;

  if (!name || makes.length === 0 || isNaN(laborRate)) {
    alert("Please fill in all fields correctly.");
    return;
  }

  chrome.storage.local.get(["laborRateGroups"], (data) => {
    const groups = data.laborRateGroups || [];

    if (editingIndex !== null) {
      groups[editingIndex] = { name, makes, laborRate };
    } else {
      groups.push({ name, makes, laborRate });
    }

    chrome.storage.local.set({ laborRateGroups: groups }, () => {
      loadGroups();
      resetForm();
    });
  });
});

// SECTION 3: Remove group
function removeGroup(index) {
  chrome.storage.local.get(["laborRateGroups"], (data) => {
    const groups = data.laborRateGroups || [];
    groups.splice(index, 1);
    chrome.storage.local.set({ laborRateGroups: groups }, loadGroups);
  });
}

// SECTION 4: Edit group
function editGroup(index) {
  chrome.storage.local.get(["laborRateGroups"], (data) => {
    const group = data.laborRateGroups[index];
    if (!group) return;

    document.getElementById("groupName").value = group.name;
    document.getElementById("makes").value = group.makes.join(", ");
    document.getElementById("laborRate").value = (group.laborRate / 100).toFixed(2);

    editingIndex = index;
    document.getElementById("formTitle").textContent = "Edit Group";
    document.getElementById("saveGroupBtn").textContent = "Save Changes";
    document.getElementById("cancelEditBtn").style.display = "inline-block";
  });
}

// SECTION 5: Cancel editing
document.getElementById("cancelEditBtn").addEventListener("click", () => {
  resetForm();
});

// SECTION 6: Reset form
function resetForm() {
  editingIndex = null;
  document.getElementById("groupName").value = "";
  document.getElementById("makes").value = "";
  document.getElementById("laborRate").value = "";
  document.getElementById("formTitle").textContent = "Add New Group";
  document.getElementById("saveGroupBtn").textContent = "Add Group";
  document.getElementById("cancelEditBtn").style.display = "none";
}

loadGroups();
