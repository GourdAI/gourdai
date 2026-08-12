/* ===== app-ui.js ===== */
/* 界面交互：附件 + 主题 + 视图 + 语音 + 侧栏 + Markdown */
/* 依赖：app-base.js */

/* ===== Attachment Helpers ===== */
var welcomeAttachmentsWrap = $('#welcomeAttachmentsWrap');
var chatAttachmentsWrap = $('#chatAttachmentsWrap');
// 异步操作版本号：每次清空 pendingFiles 时递增，FileReader 回调中校验版本号来避免过期写入
var _pendingFilesVersion = 0;

// Generate unique image extension from MIME type
function getImageExtension(mimeType) {
    if (!mimeType) return 'png';
    switch (mimeType) {
        case 'image/jpeg': return 'jpg';
        case 'image/png': return 'png';
        case 'image/gif': return 'gif';
        case 'image/webp': return 'webp';
        case 'image/bmp': return 'bmp';
        case 'image/svg+xml': return 'svg';
        case 'image/tiff': return 'tiff';
        default: return 'png';
    }
}

// Get file extension from filename (for non-image files) or MIME type (for images)
function getFileExtension(file) {
    if (!file) return 'dat';
    // If it's a File/Blob object with name property, extract from name
    if (typeof file.name === 'string') {
        var parts = file.name.split('.');
        if (parts.length > 1) return parts.pop().toLowerCase();
    }
    // Fallback: try to derive from MIME type
    if (typeof file.type === 'string' && file.type) {
        return file.type.split('/').pop().split('+')[0];
    }
    return 'dat';
}

// Generate unique file name with timestamp + random
function generateUniqueFile(originalFile, prefix) {
    if (!originalFile) return null;
    var timestamp = Date.now();
    var random = Math.random().toString(36).substring(2, 8);
    var ext = getFileExtension(originalFile);
    var newName = prefix + '-' + timestamp + '-' + random + '.' + ext;
    return new File([originalFile], newName, { type: originalFile.type, lastModified: Date.now() });
}

// Release large data from a file attachment object (base64 dataUrl + raw File)
// Keep only lightweight metadata (name, size, type) for display purposes
function releaseAttachmentData(item) {
    if (!item) return;
    if (item.dataUrl) { item.dataUrl = null; }
    if (item.blob) { item.blob = null; }
    if (item.file) { item.file = null; }
}

function handlePaste(e) {
    var clipboard = e.clipboardData || e.originalEvent.clipboardData;
    if (!clipboard) return;

    var items = clipboard.items;
    for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
            e.preventDefault();
            var file = items[i].getAsFile();
            if (!file) continue; // 防御：getAsFile() 可能返回 null
            // 生成唯一文件名，避免覆盖
            var ext = getImageExtension(items[i].type) || 'png';
            file = generateUniqueFile(file, 'pasted-image');
            processSelectedFile(file, 'image');
            return;
        }
    }

    // Handle HTML paste: convert to text preserving formatting
    var htmlData = clipboard.getData('text/html');
    if (htmlData) {
        e.preventDefault();
        var text = clipboard.getData('text/plain') || '';
        // If plain text has content, use it directly (preserves newlines/indentation)
        // textarea.value = text already preserves formatting
        var textarea = e.target;
        var start = textarea.selectionStart;
        var end = textarea.selectionEnd;
        var before = textarea.value.substring(0, start);
        var after = textarea.value.substring(end);
        textarea.value = before + text + after;
        textarea.selectionStart = textarea.selectionEnd = start + text.length;
        autoResize(textarea);
        // Trigger input event for command completion
        $(textarea).trigger('input');
    }
}

function getAttachmentsWrap() {
    return inChatMode ? chatAttachmentsWrap : welcomeAttachmentsWrap;
}

function renderAttachments() {
    // Render both wraps to keep them in sync when switching views
    renderAttachmentsWrap(welcomeAttachmentsWrap);
    renderAttachmentsWrap(chatAttachmentsWrap);
}

function renderAttachmentsWrap(wrap) {
    wrap.html('');
    if (pendingFiles.length === 0) {
        wrap.removeClass('has-items');
        return;
    }
    wrap.addClass('has-items');
    for (var i = 0; i < pendingFiles.length; i++) {
        var item = pendingFiles[i];
        var el = document.createElement('div');
        el.className = 'attachment-item';
        var typeTag = '<span class="attachment-type-tag ' + (item.attachmentsType || 'file') + '">' + (item.attachmentsType === 'image' ? GourdI18n.t('ui.multimodal') : GourdI18n.t('ui.file')) + '</span>';
        if (item.type === 'image') {
            $(el).html('<img src="' + item.dataUrl + '"/>'
                + typeTag
                + '<button class="attachment-item-remove" data-idx="' + i + '">&times;</button>');
        } else {
            $(el).html('<div class="attachment-item-file">'
                + '<span class="file-icon">📎</span>'
                + '<span class="file-name">' + escapeHtml(item.name) + '</span>'
                + '</div>'
                + typeTag
                + '<button class="attachment-item-remove" data-idx="' + i + '">&times;</button>');
        }
        wrap.append(el);
    }
}

function clearAttachmentPreview() {
    // 先释放附件中的大对象（dataUrl、file），避免内存积压
    for (var k = 0; k < pendingFiles.length; k++) {
        releaseAttachmentData(pendingFiles[k]);
    }
    pendingFiles.length = 0;
    renderAttachments();
    // 重置异步操作版本号，使后续到达的旧回调失效
    _pendingFilesVersion++;
}

function removeAttachment(idx) {
    if (idx >= 0 && idx < pendingFiles.length) {
        releaseAttachmentData(pendingFiles[idx]);
        pendingFiles.splice(idx, 1);
        renderAttachments();
    }
}

function processSelectedFile(file, attachmentsType) {
    if (!file) return;
    if (pendingFiles.length >= MAX_ATTACHMENTS) return;

    // 捕获当前版本号，用于后续异步回调校验
    var currentVersion = _pendingFilesVersion;

    // 生成唯一文件名，避免服务端 uploads/ 目录同名覆盖
    var uniqueFile = generateUniqueFile(file, 'attachment');

    if (attachmentsType === 'image') {
        // Image attachment: always treated as multimodal image
        var reader = new FileReader();
        reader.onload = function(evt) {
            if (_pendingFilesVersion !== currentVersion) return; // 过期回调，丢弃
            pendingFiles.push({ type: 'image', name: uniqueFile.name, size: uniqueFile.size, file: uniqueFile, dataUrl: evt.target.result, attachmentsType: 'image' });
            renderAttachments();
        };
        reader.onerror = function() {
            console.error('[Attachment] Image read failed:', uniqueFile.name);
        };
        reader.readAsDataURL(uniqueFile);
    } else if (file.type.indexOf('image') !== -1) {
        // File attachment + image file: show preview but mark as file type
        var reader = new FileReader();
        reader.onload = function(evt) {
            if (_pendingFilesVersion !== currentVersion) return; // 过期回调，丢弃
            pendingFiles.push({ type: 'image', name: uniqueFile.name, size: uniqueFile.size, file: uniqueFile, dataUrl: evt.target.result, attachmentsType: 'file' });
            renderAttachments();
        };
        reader.onerror = function() {
            console.error('[Attachment] Image preview read failed:', uniqueFile.name);
        };
        reader.readAsDataURL(uniqueFile);
    } else {
        pendingFiles.push({ type: 'file', name: uniqueFile.name, size: uniqueFile.size, file: uniqueFile, attachmentsType: 'file' });
        renderAttachments();
    }
}

function processSelectedFiles(fileList, attachmentsType) {
    for (var i = 0; i < fileList.length; i++) {
        if (pendingFiles.length >= MAX_ATTACHMENTS) break;
        processSelectedFile(fileList[i], attachmentsType);
    }
}

$(welcomeInput).on('paste', handlePaste);
$(chatInput).on('paste', handlePaste);

/* ===== Drag & Drop File Upload ===== */
(function() {
    var welcomeDropZone = $('#welcomeDropZone');
    var chatDropZone = $('#chatDropZone');
    var welcomeDropOverlay = $('#welcomeDropOverlay');
    var chatDropOverlay = $('#chatDropOverlay');

    // Counter to track nested enter/leave events (child elements fire their own events)
    var welcomeDragCounter = 0;
    var chatDragCounter = 0;

    function showOverlay(overlay) {
        overlay.addClass('active');
    }

    function hideOverlay(overlay) {
        overlay.removeClass('active');
    }

    function handleDrop(e, overlay, counterReset) {
        e.preventDefault();
        e.stopPropagation();
        counterReset.val = 0;
        hideOverlay(overlay);

        var dt = e.dataTransfer || (e.originalEvent && e.originalEvent.dataTransfer);
        var files = dt && dt.files;
        if (!files || files.length === 0) return;

        if (pendingFiles.length >= MAX_ATTACHMENTS) {
            showToast(GourdI18n.t('ui.attachment_limit', MAX_ATTACHMENTS), 'error');
            return;
        }

        // Separate files into images and non-images for proper processing
        for (var i = 0; i < files.length; i++) {
            if (pendingFiles.length >= MAX_ATTACHMENTS) {
                showToast(GourdI18n.t('ui.attachment_partial_limit', MAX_ATTACHMENTS), 'error');
                break;
            }
            var file = files[i];
            if (!file) continue; // 防御：文件可能被移除
            var isImage = file.type.indexOf('image/') === 0;
            processSelectedFile(file, isImage ? 'image' : 'file');
        }
    }

    function bindDropZone(zone, overlay, counter) {
        // Prevent default browser behavior (opening the file)
        zone.on('dragenter', function(e) {
            e.preventDefault();
            e.stopPropagation();
            counter.val++;
            showOverlay(overlay);
        });

        zone.on('dragover', function(e) {
            e.preventDefault();
            e.stopPropagation();
            // Keep overlay visible during drag over
        });

        zone.on('dragleave', function(e) {
            e.preventDefault();
            e.stopPropagation();
            counter.val--;
            if (counter.val <= 0) {
                counter.val = 0;
                hideOverlay(overlay);
            }
        });

        zone.on('drop', function(e) {
            handleDrop(e, overlay, counter);
        });
    }

    bindDropZone(welcomeDropZone, welcomeDropOverlay, { val: welcomeDragCounter });
    bindDropZone(chatDropZone, chatDropOverlay, { val: chatDragCounter });
})();

// Attachment remove buttons - use event delegation on both wraps
welcomeAttachmentsWrap.on('click', function(e) {
    var btn = e.target.closest('.attachment-item-remove');
    if (btn) removeAttachment(parseInt(btn.getAttribute('data-idx')));
});
chatAttachmentsWrap.on('click', function(e) {
    var btn = e.target.closest('.attachment-item-remove');
    if (btn) removeAttachment(parseInt(btn.getAttribute('data-idx')));
});

// Attach button handlers
$('#welcomeAttachBtn').on('click', function(e) {
    e.stopPropagation();
    $('#welcomeAttachInput')[0].click();
});
$('#chatAttachBtn').on('click', function(e) {
    e.stopPropagation();
    $('#chatAttachInput')[0].click();
});
$('#welcomeAttachInput').on('change', function(e) {
    if (e.target.files && e.target.files.length > 0) processSelectedFiles(e.target.files, 'file');
    e.target.value = '';
});
$('#chatAttachInput').on('change', function(e) {
    if (e.target.files && e.target.files.length > 0) processSelectedFiles(e.target.files, 'file');
    e.target.value = '';
});

// Image button handlers
$('#welcomeImageBtn').on('click', function(e) {
    e.stopPropagation();
    $('#welcomeImageInput')[0].click();
});
$('#chatImageBtn').on('click', function(e) {
    e.stopPropagation();
    $('#chatImageInput')[0].click();
});
$('#welcomeImageInput').on('change', function(e) {
    if (e.target.files && e.target.files.length > 0) processSelectedFiles(e.target.files, 'image');
    e.target.value = '';
});
$('#chatImageInput').on('change', function(e) {
    if (e.target.files && e.target.files.length > 0) processSelectedFiles(e.target.files, 'image');
    e.target.value = '';
});

/* ===== Marked ===== */
if (typeof marked !== 'undefined') { marked.setOptions({ breaks: true, gfm: true }); }
var _mdCache = new Map();
var _MD_CACHE_MAX = 100;
var _MD_CACHE_MAX_LENGTH = 5000; // 超过此长度的文本不缓存（避免大字符串 Key 占用过多内存）
function renderMd(text) {
    if (typeof marked !== 'undefined') {
        if (!text) return '';
        if (text.length < _MD_CACHE_MAX_LENGTH) {
            var cached = _mdCache.get(text);
            if (cached) return cached;
            var html = marked.parse(text);
            _mdCache.set(text, html);
            if (_mdCache.size > _MD_CACHE_MAX) {
                var firstKey = _mdCache.keys().next().value;
                _mdCache.delete(firstKey);
            }
            return html;
        }
        return marked.parse(text);
    }
    return text.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

/* 清空 Markdown 缓存（供会话切换/回放结束时调用，释放临时内存） */
function clearMdCache() {
    _mdCache.clear();
}
window.clearMdCache = clearMdCache;

/* ===== Highlight.js ===== */
function highlightCodeBlocks(container) {
    if (!container || typeof hljs === 'undefined') return;
    var blocks = $(container).find('pre code:not([data-hljs-collected]):not(.language-mermaid)');
    if (blocks.length === 0) return;
    blocks.each(function() { this.dataset.hljsCollected = 'true'; });
    
    // 分片高亮：当代码块数量较多时，分帧处理以避免阻塞
    var HLJS_CHUNK_SIZE = 10; // 每帧处理 10 个代码块
    var idx = 0;
    var total = blocks.length;
    
    function highlightChunk() {
        var end = Math.min(idx + HLJS_CHUNK_SIZE, total);
        for (; idx < end; idx++) {
            var block = blocks[idx];
            if (block && !block.dataset.hljsHighlighted) {
                block.dataset.hljsHighlighted = 'true';
                try { hljs.highlightElement(block); } catch(e) {}
            }
        }
        if (idx < total) {
            requestAnimationFrame(highlightChunk);
        }
    }
    
    // 代码块少于阈值时直接同步处理，避免不必要的分片开销
    if (total <= HLJS_CHUNK_SIZE) {
        highlightChunk();
    } else {
        requestAnimationFrame(highlightChunk);
    }
}

/* ===== Mermaid ===== */
function processMermaidBlocks(container) {
    if (!container || typeof mermaid === 'undefined') return;
    var blocks = container.querySelectorAll('pre code.language-mermaid:not([data-mermaid-processed])');
    if (blocks.length === 0) return;

    var nodes = [];
    for (var i = 0; i < blocks.length; i++) {
        var codeEl = blocks[i];
        codeEl.setAttribute('data-mermaid-processed', 'true');
        var preEl = codeEl.parentNode;
        var txt = codeEl.textContent.trim();
        if (!txt) continue;

        var div = document.createElement('div');
        div.id = 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 8);
        div.className = 'mermaid-svg';
        div.style.cssText = 'text-align:center;padding:10px 0;overflow-x:auto;';
        div.textContent = txt;
        preEl.parentNode.replaceChild(div, preEl);
        nodes.push(div);
    }

    if (nodes.length > 0 && mermaid.run) {
        mermaid.run({ nodes: nodes, suppressErrors: true }).catch(function() {});
    }
}

function applyHljsTheme(theme) {
    var $lightLink = $('#hljs-light-theme');
    var $darkLink = $('#hljs-dark-theme');
    if (!$lightLink.length || !$darkLink.length) return;
    if (theme === 'dark') {
        $lightLink.prop('disabled', true).prop('media', 'not all');
        $darkLink.prop('disabled', false).prop('media', 'all');
    } else {
        $darkLink.prop('disabled', true).prop('media', 'not all');
        $lightLink.prop('disabled', false).prop('media', 'all');
    }
}

/* ===== Theme ===== */
// 首帧已由 index.html <body> 顶部的内联脚本按 localStorage 预置主题（防闪烁）；
// 这里再读一次作为常规初始化，与预置值一致，幂等。
var currentTheme = localStorage.getItem('chat-theme') || 'light';
$('body').attr('data-theme', currentTheme);
applyHljsTheme(currentTheme);

/* ===== Mermaid Init ===== */
if (typeof mermaid !== 'undefined') {
    mermaid.initialize({
        startOnLoad: false,
        theme: currentTheme === 'dark' ? 'dark' : 'default',
        securityLevel: 'loose',
        fontFamily: 'var(--font-sans)',
    });
}

// 启动时从后端同步主题（清空 localStorage 后仍能恢复）。
// 桌面端延后到后端就绪再拉，避免冷启动期占用连接；此前已由上面的 localStorage 值先行生效，无闪烁。
__whenBackendReady(function () {
    $.get('/web/settings/general', function(resp) {
        if (resp.code === 200 && resp.data && resp.data.darkMode != null) {
            applyTheme(resp.data.darkMode ? 'dark' : 'light');
        }
    });
});

function applyTheme(theme) {
    currentTheme = theme;
    $('body').attr('data-theme', theme);
    localStorage.setItem('chat-theme', theme);
    applyHljsTheme(theme);
    if (typeof mermaid !== 'undefined') {
        mermaid.initialize({ theme: theme === 'dark' ? 'dark' : 'default' });
    }
    // sync checkbox if settings panel is open
    var cb = document.getElementById('generalDarkMode');
    if (cb) cb.checked = (theme === 'dark');
}

// Init dark mode checkbox when settings opens
$(document).on('change', '#generalDarkMode', function() {
    var isDark = this.checked;
    applyTheme(isDark ? 'dark' : 'light');
    $.ajax({ url: '/web/settings/general/save', method: 'POST', data: JSON.stringify({darkMode: isDark}), contentType: 'application/json', dataType: 'json' });
});

// Sync checkbox state when settings panel opens
$(document).on('click', '#settingsBtn', function() {
    setTimeout(function() {
        var cb = document.getElementById('generalDarkMode');
        if (cb) cb.checked = (currentTheme === 'dark');
    }, 50);
});

/* ===== View Switch ===== */
function switchToChatMode() {
    if (inChatMode) return;
    inChatMode = true;
    $(welcomeView).hide();
    $(chatView).addClass('active');
    // 清除可能残留的加载按钮，避免旧会话的按钮在新视图里闪现
    if (messagesWrap) $(messagesWrap).find('.chat-load-more-wrapper').remove();
    chatInput.focus();
}
function switchToWelcomeMode() {
    inChatMode = false;
    if (typeof forgetActiveSession === 'function') forgetActiveSession();
    SESSION_ID = (typeof newSessionId === 'function') ? newSessionId() : ('chat-' + Date.now().toString(36));
    // 先把当前对话已选的模型/思考档位继承给新会话（写缓存），再激活，
    // 否则 setActiveSession→refreshSessionModel 会拉后端默认把选择冲掉。
    if (typeof inheritSelectionToSession === 'function') inheritSelectionToSession(SESSION_ID);
    setActiveSession(SESSION_ID);
    $(welcomeView).show();
    $(chatView).removeClass('active');
    welcomeInput.focus();
    // 新对话时禁用“历史消息”按钮（循环任务按钮保持可用）
    $('#welcomeHistoryBtn').prop('disabled', true);
    $('#welcomeLoopBtn').prop('disabled', false);
    // Reset model UI to new session
    if (typeof modelsLoaded !== 'undefined' && modelsLoaded) renderModelUI();
    // 切欢迎页时清空附件预览，避免跨视图残留
    if (typeof clearAttachmentPreview === 'function') clearAttachmentPreview();
}

/* ===== Auto-resize ===== */
$(welcomeInput).on('input', function() { autoResize(this); });
$(chatInput).on('input', function() { autoResize(this); });

/* ===== Input box height drag adjustment (top drag bar: min = current default height, max = 320px, double-click to restore) ===== */
var INPUT_RESIZE_MAX = 320;
function initInputResizeHandle(handle, textarea) {
    if (!handle || !textarea) return;
    var dragging = false, startY = 0, startH = 0;
    // The container has transition:all, and during dragging the outer frame lags 250ms behind the textarea's height, causing visual desync;
    // during dragging, temporarily disable the container's transition via .resizing (restored on mouseup).
    var box = textarea.closest('.input-box, .welcome-input-box');
    handle.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        e.preventDefault();
        dragging = true;
        startY = e.clientY;
        startH = textarea.offsetHeight;
        handle.classList.add('dragging');
        if (box) box.classList.add('resizing');
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        // Dragging upward (clientY decreases) increases the height
        var minH = parseFloat(getComputedStyle(textarea).minHeight) || textarea.offsetHeight;
        var h = Math.max(minH, Math.min(INPUT_RESIZE_MAX, startH + (startY - e.clientY)));
        textarea._manualH = h;
        textarea.style.height = h + 'px';
    });
    document.addEventListener('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('dragging');
        if (box) box.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
    handle.addEventListener('dblclick', function () {
        textarea._manualH = 0;
        autoResize(textarea);
    });
}
initInputResizeHandle(document.querySelector('.welcome-input-box .input-resize-handle'), welcomeInput);
initInputResizeHandle(document.querySelector('.input-box .input-resize-handle'), chatInput);

/* ===== Voice Input (Web Speech API) - 按住说话（类似微信） ===== */
var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
var recognition = null;
var voiceRecording = false;
var voiceTargetInput = null; // 当前语音目标 textarea
var voiceBaseText = '';      // 开始录音时 textarea 已有文本
var voiceFinalTranscript = ''; // 累计的最终识别文本

var welcomeVoiceBtn = $('#welcomeVoiceBtn');
var chatVoiceBtn = $('#chatVoiceBtn');

var voiceRafPending = false; // 限制 DOM 更新频率

function initVoice() {
    if (!SpeechRecognition) return; // 浏览器不支持
    // 桌面端（Electron）降级：Web Speech API 依赖 Chrome/Edge 内置的 Google 语音服务，
    // Electron（开源 Chromium）没有该服务端点，start() 必然失败。故桌面端不显示语音按钮。
    if (window.__GOURD_IPC__ && window.__GOURD_IPC__.isDesktop) return;
    recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = true; // 按住期间持续识别
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = function(event) {
        var interimTranscript = '';
        var finalTranscript = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
            var transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcript;
            } else {
                interimTranscript += transcript;
            }
        }
        // 累积最终结果
        if (finalTranscript) {
            voiceFinalTranscript += finalTranscript;
        }
        // 用 RAF 节流 DOM 更新，避免频繁重绘拖慢感知
        if (!voiceRafPending && voiceTargetInput) {
            voiceRafPending = true;
            requestAnimationFrame(function() {
                voiceRafPending = false;
                if (voiceTargetInput) {
                    voiceTargetInput.value = voiceBaseText + voiceFinalTranscript + interimTranscript;
                    autoResize(voiceTargetInput);
                }
            });
        }
    };

    recognition.onerror = function(event) {
        // no-speech 和 aborted 是正常情况，不需要提示和停止
        if (event.error === 'no-speech' || event.error === 'aborted') {
            return;
        }

        stopVoiceRecording();

        if (event.error === 'not-allowed') {
            showToast(GourdI18n.t('ui.mic_permission_denied'), 'error');
        } else if (event.error === 'audio-capture') {
            showToast(GourdI18n.t('ui.mic_not_detected'), 'error');
        } else if (event.error === 'network') {
            showToast(GourdI18n.t('ui.voice_network_error'), 'error');
        } else {
            showToast(GourdI18n.t('ui.voice_error', [event.error]), 'error');
        }
    };

    recognition.onend = function() {
        // 如果还在按住状态（voiceRecording），自动重启继续识别
        if (voiceRecording) {
            try {
                recognition.start();
            } catch(e) {
                stopVoiceRecording();
            }
        } else {
            stopVoiceRecording();
        }
    };

    // 显示语音按钮
    welcomeVoiceBtn.removeClass('hidden');
    chatVoiceBtn.removeClass('hidden');
}

function startVoiceRecording(inputEl) {
    if (!recognition) return;
    if (voiceRecording) return;

    voiceTargetInput = inputEl;
    voiceBaseText = inputEl.value;
    voiceFinalTranscript = '';
    voiceRecording = true;

    // 强制停止旧实例，避免 InvalidStateError
    try {
        recognition.stop();
    } catch(e) {
        // 忽略停止错误
    }

    // 短暂延迟后启动，确保旧实例完全停止
    setTimeout(function() {
        if (!voiceRecording) return; // 用户已经松开了
        try {
            recognition.start();
        } catch(e) {
            voiceRecording = false;
            var btn = (inputEl === welcomeInput) ? welcomeVoiceBtn : chatVoiceBtn;
            btn.removeClass('recording');
            showToast(GourdI18n.t('ui.voice_start_failed', [e.message]), 'error');
        }
    }, 100);

    // 更新按钮状态
    var btn = (inputEl === welcomeInput) ? welcomeVoiceBtn : chatVoiceBtn;
    btn.addClass('recording');
    btn.prop('title', GourdI18n.t('ui.release_to_stop'));
}

function stopVoiceRecording() {
    if (!voiceRecording && !recognition) return;
    voiceRecording = false;
    try { if (recognition) recognition.stop(); } catch(e) {}

    // 更新按钮状态
    welcomeVoiceBtn.removeClass('recording');
    chatVoiceBtn.removeClass('recording');
    welcomeVoiceBtn.prop('title', GourdI18n.t('ui.hold_to_speak'));
    chatVoiceBtn.prop('title', GourdI18n.t('ui.hold_to_speak'));

    // 保留识别到的文本，重置基线以便下次追加
    if (voiceTargetInput) {
        voiceBaseText = voiceTargetInput.value;
    }
    voiceFinalTranscript = '';
    voiceTargetInput = null;
}

// --- 按住说话：按下开始录音，松开结束（类似微信） ---
function bindVoiceHold(btn, inputEl) {
    // 鼠标：按下开始，松开结束
    btn.on('mousedown', function(e) {
        e.preventDefault();
        startVoiceRecording(inputEl);
    });
    btn.on('mouseup', function(e) {
        e.preventDefault();
        stopVoiceRecording();
    });
    btn.on('mouseleave', function() {
        if (voiceRecording) stopVoiceRecording();
    });

    // 触摸：按下开始，松开结束
    btn.on('touchstart', function(e) {
        e.preventDefault();
        startVoiceRecording(inputEl);
    });
    btn.on('touchend', function(e) {
        e.preventDefault();
        stopVoiceRecording();
    });
    btn.on('touchcancel', function() {
        if (voiceRecording) stopVoiceRecording();
    });
}

bindVoiceHold(welcomeVoiceBtn, welcomeInput);
bindVoiceHold(chatVoiceBtn, chatInput);

initVoice();

/* ===== Sidebar Search Toggle ===== */
(function() {
    var sidebar = $('.sidebar');

    /* 侧边栏收起功能已移除：清理历史遗留的 collapsed 状态，避免老用户被卡在收起态（已无展开按钮）。 */
    sidebar.removeClass('collapsed');
    try { localStorage.removeItem('sidebar-collapsed'); } catch (e) {}

    var searchBtn = $('#sidebarSearchBtn');
    var searchBar = $('#sidebarSearchBar');
    var searchInput = $('#sidebarSearchInput');
    var searchClear = $('#sidebarSearchClear');
    var historyList = $('#historyList');

    if (searchBtn.length) {
        searchBtn.on('click', function() {
            var visible = searchBar.is(':visible');
            if (visible) {
                searchBar.hide();
                searchInput.val('');
                searchClear.hide();
                // Restore full history list
                historyList.find('.sidebar-item').show();
            } else {
                searchBar.show();
                searchInput.focus();
            }
        });
    }

    if (searchInput.length) {
        searchInput.on('input', function() {
            var val = this.value.toLowerCase().trim();
            searchClear.toggle(val.length > 0);
            historyList.find('.sidebar-item').each(function() {
                var label = $(this).find('.sidebar-item-label').text().toLowerCase();
                $(this).toggle(val === '' || label.indexOf(val) >= 0);
            });
        });
    }

    if (searchClear.length) {
        searchClear.on('click', function() {
            searchInput.val('').trigger('input').focus();
        });
    }
})();

/* ===== Sidebar Resize ===== */
(function() {
    var $sidebar = $('.sidebar');
    var $handle = $('#sidebarResizeHandle');

    if (!$handle.length || !$sidebar.length) return;

    var SIDEBAR_MIN_WIDTH = 180;
    var SIDEBAR_MAX_WIDTH = 600;

    // Init resize dragging
    (function initResize() {
        var isDragging = false;
        var startX = 0;
        var startWidth = 0;

        $handle.on('mousedown', function(e) {
            isDragging = true;
            startX = e.clientX;
            startWidth = $sidebar[0].offsetWidth;
            $handle.addClass('dragging');
            $(document.body).css({ cursor: 'col-resize', userSelect: 'none' });
            e.preventDefault();
        });

        $(document).on('mousemove', function(e) {
            if (!isDragging) return;
            var dx = e.clientX - startX;
            var newWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + dx));
            $sidebar.css('width', newWidth + 'px');
            localStorage.setItem('sidebar-width', newWidth);
        });

        $(document).on('mouseup', function() {
            if (!isDragging) return;
            isDragging = false;
            $handle.removeClass('dragging');
            $(document.body).css({ cursor: '', userSelect: '' });
        });
    })();

    // Restore saved width
    (function restoreWidth() {
        var savedWidth = localStorage.getItem('sidebar-width');
        if (savedWidth) {
            var w = parseInt(savedWidth, 10);
            if (w >= SIDEBAR_MIN_WIDTH && w <= SIDEBAR_MAX_WIDTH) {
                $sidebar.css('width', w + 'px');
            }
        }
    })();
})();

/* ===== Mobile Sidebar Drawer ===== */
(function() {
    var mobileMenuBtn = $('#mobileMenuBtn');
    var mobileOverlay = $('#mobileOverlay');
    var sidebar = $('.sidebar');
    if (!mobileMenuBtn.length || !sidebar.length) return;

    mobileMenuBtn.on('click', function() {
        sidebar.toggleClass('mobile-open');
        if (mobileOverlay.length) mobileOverlay.toggleClass('show');
    });

    if (mobileOverlay.length) {
        mobileOverlay.on('click', function() {
            sidebar.removeClass('mobile-open');
            mobileOverlay.removeClass('show');
        });
    }

    // Close sidebar when selecting a chat on mobile
    var sidebarList = $('.sidebar-list');
    if (sidebarList.length) {
        sidebarList.on('click', function(e) {
            var item = e.target.closest('.sidebar-item');
            if (item && window.innerWidth <= 768) {
                sidebar.removeClass('mobile-open');
                if (mobileOverlay.length) mobileOverlay.removeClass('show');
            }
        });
    }
})();

/* ===== Keyboard Shortcuts ===== */
$(document).on('keydown', function(e) {
    // Ctrl/Cmd + N: New chat
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        if (typeof newChatBtn !== 'undefined') newChatBtn.click();
    }
    // Escape: close modals, lightbox
    if (e.key === 'Escape') {
        var $lightbox = $('.lightbox-overlay');
        if ($lightbox.length) $lightbox.remove();
    }
});

/* ===== 消息执行队列 UI ===== */
// 根据文件扩展名获取图标
function getFileIcon(fileName) {
    var ext = fileName.split('.').pop().toLowerCase();
    var iconMap = {
        'pdf': '📄', 'doc': '📝', 'docx': '📝', 'xls': '📊', 'xlsx': '📊',
        'ppt': '📽️', 'pptx': '📽️', 'zip': '📦', 'rar': '📦', '7z': '📦',
        'tar': '📦', 'gz': '📦', 'txt': '📃', 'csv': '📊', 'json': '📋',
        'xml': '📋', 'yaml': '⚙️', 'yml': '⚙️', 'md': '📑', 'java': '☕',
        'py': '🐍', 'js': '📜', 'ts': '📜', 'css': '🎨', 'html': '🌐',
        'c': '⚙️', 'cpp': '⚙️', 'h': '⚙️', 'go': '🔧', 'rs': '🦀',
        'sh': '💻', 'bat': '💻', 'ps1': '💻', 'sql': '🗄️', 'db': '🗄️'
    };
    return iconMap[ext] || '📎';
}

// ==================== 消息队列 UI 管理 ====================

// 全局队列处理状态
var _queueProcessing = {}; // { sessionId: boolean }

/* 输入框上方的 chip 容器（#chatTodoChipWrap）同时承载 todo chip 与 queue chip，
   二者任一可见即应显示该容器。由 app-todos.js 与本模块分别置位后统一汇算。 */
window._queueChipVisible = false;
function updateChipWrapVisibility() {
    var $wrap = $('#chatTodoChipWrap');
    if (!$wrap.length) return;
    var visible = !!window._queueChipVisible || !!window._todoChipVisible;
    $wrap.css('display', visible ? 'flex' : 'none');
}
window.updateChipWrapVisibility = updateChipWrapVisibility;

/* 更新队列 chip 按钮（#chatQueueChip）显隐与 badge 计数 */
function updateQueueChip(queue) {
    var $chip = $('#chatQueueChip');
    if (!$chip.length) return;
    var count = (queue && queue.length) || 0;
    var $badge = $('#queueBadge');
    if ($badge.length) {
        $badge.text(count);
        $badge.css('display', count > 0 ? '' : 'none');
    }
    $chip.css('display', count > 0 ? '' : 'none');
    window._queueChipVisible = count > 0;
    updateChipWrapVisibility();
}

async function updateMessageQueueUI() {
    if (!window.messageQueue) return;
    var sessionId = activeSessionId || SESSION_ID || 'chat-default';

    try {
        var queue = await window.messageQueue.getQueue(sessionId);
        queue = queue || [];

        // chat 模式（对话视图）
        var $chatContainer = $('#message-queue-container');
        renderQueueContainer($chatContainer, '#message-queue-list', '#queue-count', queue, sessionId);

        // 欢迎页
        var $welcomeContainer = $('#welcome-message-queue-container');
        renderQueueContainer($welcomeContainer, '#welcome-message-queue-list', '#welcome-queue-count', queue, sessionId);

        // chip 按钮 + badge（队列与 todo 共享 #chatTodoChipWrap，任一有内容即显示）
        updateQueueChip(queue);
    } catch(e) {
        // 静默失败
    }
}

function renderQueueContainer($container, listSelector, countSelector, queue, sessionId) {
    if (!$container || !$container.length) return;
    if (!queue || queue.length === 0) {
        $container.hide();
    } else {
        // 悬浮面板模式下，仅渲染内容，不自动显示面板
        // 面板由用户点击 chip 触发显示
        var $list = $(listSelector);
        if ($list.length) {
            $list.empty();
            var isProcessing = _queueProcessing[sessionId] || false;

            queue.forEach(function(item, index) {
                var $item = $('<div>').addClass('queue-item').attr('data-index', index);

                if (isProcessing && index === 0) {
                    $item.addClass('processing');
                }

                var statusHtml = '';
                if (isProcessing && index === 0) {
                    // 处理中：绿色对勾（与 todo-done 一致）
                    statusHtml = '<span class="queue-item-status processing"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>';
                } else {
                    // 等待中：空心圆圈（与 todo-pending 一致）
                    statusHtml = '<span class="queue-item-status pending"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg></span>';
                }

                var contentHtml = '';
                if (item.content) {
                    contentHtml += '<span class="queue-item-text">' + escapeHtml(item.content) + '</span>';
                }

                var imagePaths = item.imagePaths || [];
                var filePaths = item.filePaths || [];
                if (imagePaths.length > 0 || filePaths.length > 0) {
                    contentHtml += '<span class="queue-item-attachments">';
                    if (imagePaths.length > 0) {
                        contentHtml += '<span class="queue-attach-badge">图' + imagePaths.length + '</span>';
                    }
                    if (filePaths.length > 0) {
                        contentHtml += '<span class="queue-attach-badge">文件' + filePaths.length + '</span>';
                    }
                    contentHtml += '</span>';
                }

                $item.html(
                    '<span class="queue-item-index">' + (index + 1) + '</span>' +
                    contentHtml +
                    statusHtml +
                    (!isProcessing ? '<button class="queue-item-remove" title="移除">&times;</button>' : '')
                );

                if (!isProcessing) {
                    $item.find('.queue-item-remove').on('click', function() {
                        if (index === 0) {
                            window.messageQueue.shift(sessionId).then(function() {
                                updateMessageQueueUI();
                            });
                        } else {
                            showToast('请等待前面的消息发送后再移除', 'warning');
                        }
                    });
                }
                $list.append($item);
            });
        }
        var $count = $(countSelector);
        if ($count.length) $count.text(queue.length + ' 条');
    }
}

async function processMessageQueue(targetSessionId) {
    var sessionId = targetSessionId || activeSessionId || SESSION_ID || 'chat-default';

    if (!window.messageQueue) return;

    var total = await window.messageQueue.size(sessionId);
    if (total === 0) {
        updateMessageQueueUI();
        return;
    }

    _queueProcessing[sessionId] = true;
    try {
        await processNextQueuedMessage(sessionId);
    } finally {
        _queueProcessing[sessionId] = false;
        updateMessageQueueUI();
    }
}

async function processNextQueuedMessage(sessionId) {
    var item = await window.messageQueue.shift(sessionId);

    if (!item) {
        // 队列为空，结束
        return;
    }

    updateMessageQueueUI();

    // 设置输入框文本：按当前视图选择对应输入框（chatInput / welcomeInput）。
    // 此前用 $('#chat-input') 选择器命中不到任何元素（实际 id 为 chatInput），
    // 导致出队后 sendMessage 读到空输入直接 return，队列消息永远发不出去。
    var text = item.content || '';
    if (inChatMode) {
        if (chatInput) { chatInput.value = text; autoResize(chatInput); }
    } else {
        if (welcomeInput) { welcomeInput.value = text; autoResize(welcomeInput); }
    }

    // 发送消息
    sendMessage();

    // 等待发送完成
    await new Promise(function(resolve) {
        var checkInterval = setInterval(function() {
            if (!isStreaming) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 500);
    });

    // 继续处理下一条
    var remainingAfter = await window.messageQueue.size(sessionId);
    if (remainingAfter > 0) {
        await processNextQueuedMessage(sessionId);
    }
}

// 清空队列按钮
$(document).on('click', '#queue-clear-btn', function() {
    var sessionId = activeSessionId || SESSION_ID || 'chat-default';
    if (window.messageQueue && !_queueProcessing[sessionId]) {
        window.messageQueue.clear(sessionId).then(function() {
            updateMessageQueueUI();
        });
    }
});
$(document).on('click', '#welcome-queue-clear-btn', function() {
    var sessionId = activeSessionId || SESSION_ID || 'chat-default';
    if (window.messageQueue && !_queueProcessing[sessionId]) {
        window.messageQueue.clear(sessionId).then(function() {
            updateMessageQueueUI();
        });
    }
});

/* 点击队列 chip：显示/隐藏队列面板，或折叠/展开列表 */
$(document).on('click', '#chatQueueChip', function(e) {
    e.stopPropagation();
    var $target = $('#message-queue-container');
    if (!$target.length) return;

    if ($target.is(':hidden')) {
        // 面板隐藏时，先关闭所有其他面板，再显示并展开
        if (typeof window.closeAllToolbarPanels === 'function') window.closeAllToolbarPanels();
        $target.show().removeClass('collapsed');
    } else if ($target.hasClass('collapsed')) {
        // 面板显示但折叠时，展开
        $target.removeClass('collapsed');
    } else {
        // 面板显示且展开时，隐藏整个面板
        $target.hide();
    }
});

window.updateMessageQueueUI = updateMessageQueueUI;
window.processMessageQueue = processMessageQueue;

