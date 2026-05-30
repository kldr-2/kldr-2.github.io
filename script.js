const basePath = "media content 2/";

const mediaItems = [
  {
    type: "video",
    file: "MASK OFF.mp4",
    title: "MASK OFF // Motion",
    size: "large"
  },
  {
    type: "image",
    file: "art room with man.jpg",
    title: "Art Room // Portrait",
    size: "medium"
  },
  {
    type: "image",
    file: "art room.jpg",
    title: "Art Room // Space",
    size: "medium"
  },
  {
    type: "image",
    file: "group portrait.jpg",
    title: "Group Portrait",
    size: "large"
  },
  {
    type: "image",
    file: "pin board art.jpg",
    title: "Pin Board",
    size: "small"
  },
  {
    type: "image",
    file: "unnamed painting.jpg",
    title: "Unnamed // Canvas",
    size: "medium"
  },
  {
    type: "image",
    file: "“Flash of the Spirit “ (sold).jpg",
    title: "Flash of the Spirit (Sold)",
    size: "large"
  },
  {
    type: "image",
    file: "“Two side of the coin”(sold).jpg",
    title: "Two Side of the Coin (Sold)",
    size: "medium"
  },
  {
    type: "image",
    file: "🦎.jpg",
    title: "Lizard",
    size: "small"
  }
];

const resolveHeroVideo = () =>
  mediaItems.find((item) => item.type === "video")?.file || "";

const heroVideoSource = resolveHeroVideo();
const backdropVideo = document.getElementById("backdrop-video");
if (backdropVideo && heroVideoSource) {
  backdropVideo.src = encodeURI(`${basePath}${heroVideoSource}`);
}

const archiveGrid = document.getElementById("archive-grid");
const sizeClassMap = {
  large: "span-large",
  medium: "span-medium",
  small: "span-small"
};

const createArchiveCard = (item) => {
  const card = document.createElement("article");
  const sizeClass = sizeClassMap[item.size] || sizeClassMap.small;
  card.className = `archive-card glass liquid-glass tilt reveal ${sizeClass}`;
  card.dataset.title = item.title || "";
  card.dataset.file = item.file;
  card.dataset.type = item.type;

  const frame = document.createElement("div");
  frame.className = "archive-frame";

  let media;
  if (item.type === "video") {
    media = document.createElement("video");
    media.autoplay = true;
    media.loop = true;
    media.muted = true;
    media.playsInline = true;
  } else {
    media = document.createElement("img");
    media.loading = "lazy";
    media.alt = item.title || "Gallery image";
  }

  media.src = encodeURI(`${basePath}${item.file}`);

  const overlay = document.createElement("div");
  overlay.className = "archive-overlay";

  const caption = document.createElement("div");
  caption.className = "archive-caption";

  const pill = document.createElement("div");
  pill.className = "archive-pill glass";
  pill.textContent = item.title || "";

  caption.appendChild(pill);
  frame.append(media, overlay, caption);
  card.appendChild(frame);
  return card;
};

if (archiveGrid) {
  mediaItems.forEach((item) => {
    archiveGrid.appendChild(createArchiveCard(item));
  });
}

const modal = document.getElementById("artwork-modal");
const modalBackdrop = document.getElementById("modal-backdrop");
const modalClose = document.getElementById("modal-close");
const modalImage = document.getElementById("modal-image");
const modalVideo = document.getElementById("modal-video");
const modalTitle = document.getElementById("modal-title");

const openModal = (title, file, type) => {
  if (!modal || !modalTitle || !file) return;
  modalTitle.textContent = title || "";
  
  const fileUrl = encodeURI(`${basePath}${file}`);

  if (type === "video") {
    modalImage.style.display = "none";
    modalVideo.style.display = "block";
    modalVideo.src = fileUrl;
  } else {
    modalVideo.style.display = "none";
    modalVideo.src = "";
    modalImage.style.display = "block";
    modalImage.src = fileUrl;
  }

  modal.classList.add("is-visible");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
};

const closeModal = () => {
  if (!modal) return;
  modal.classList.remove("is-visible");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  
  if (modalVideo) {
    modalVideo.pause();
    modalVideo.src = "";
  }
};

if (archiveGrid) {
  archiveGrid.addEventListener("click", (event) => {
    const target = event.target.closest(".archive-card");
    if (!target) return;
    openModal(target.dataset.title, target.dataset.file, target.dataset.type);
  });
}

if (modalBackdrop) {
  modalBackdrop.addEventListener("click", closeModal);
}

if (modalClose) {
  modalClose.addEventListener("click", closeModal);
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeModal();
  }
});

const applyTilt = (element, intensity = 12) => {
  const updateTilt = (event) => {
    const rect = element.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    element.style.setProperty("--tilt-x", `${(-y * intensity).toFixed(2)}deg`);
    element.style.setProperty("--tilt-y", `${(x * intensity).toFixed(2)}deg`);
    element.classList.add("is-active");
  };

  const resetTilt = () => {
    element.style.setProperty("--tilt-x", "0deg");
    element.style.setProperty("--tilt-y", "0deg");
    element.classList.remove("is-active");
  };

  element.addEventListener("pointermove", updateTilt);
  element.addEventListener("pointerleave", resetTilt);
};

document.querySelectorAll(".tilt").forEach((element) => {
  applyTilt(element);
});

const enterButton = document.getElementById("enter-button");
if (enterButton) {
  enterButton.addEventListener("click", () => {
    const target = document.getElementById("archive");
    if (target) {
      target.scrollIntoView({ behavior: "smooth" });
    }
  });
}

const heroMedia = document.querySelector(".hero-media");
const updateHeroPointer = (event) => {
  if (!heroMedia) return;
  const rect = heroMedia.getBoundingClientRect();
  const clientX = event.touches ? event.touches[0].clientX : event.clientX;
  const clientY = event.touches ? event.touches[0].clientY : event.clientY;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  heroMedia.style.setProperty("--mouse-x", `${x}px`);
  heroMedia.style.setProperty("--mouse-y", `${y}px`);
};

window.addEventListener("pointermove", updateHeroPointer);
window.addEventListener("touchmove", updateHeroPointer, { passive: true });

const revealElements = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.2 }
  );

  revealElements.forEach((element) => observer.observe(element));
} else {
  revealElements.forEach((element) => element.classList.add("is-visible"));
}
