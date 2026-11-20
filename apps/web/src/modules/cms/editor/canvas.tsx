"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import type { Editor, JSONContent } from "@tiptap/core";
import {
  Bold,
  Code,
  Heading2,
  Heading3,
  Heading4,
  ImagePlus,
  Info,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  SquareCode,
  Undo2,
  Unlink,
} from "lucide-react";
import { Button, Input } from "@/components/ui/primitives";
import {
  CALLOUT_TONES,
  LIMITS,
  linkAllowed,
  type TiptapNode,
} from "../../../../../../packages/content-doc/src/index.ts";
import { containerDepth, editorExtensions, type ImageSource } from "./schema";
import { normalizePastedHtml, type PasteNotice } from "./paste";
import type { EditorText } from "../labels";

// The writing surface of the content editor (CH1.14b). Loaded lazily and only
// in the browser (next/dynamic, ssr: false); it reports TipTap JSON, and the
// page maps it to orbit-doc before saving.

export type CanvasProps = {
  initial: TiptapNode;
  editable: boolean;
  t: EditorText;
  srcOf: ImageSource;
  /**
   * Reports the document; a returned document replaces the canvas content
   * (what orbit-doc can store), so the canvas never shows unsaved structure.
   */
  onChange: (json: TiptapNode) => TiptapNode | void;
  onPaste: (notice: PasteNotice) => void;
  /** Opens the media library; resolves with the chosen asset id. */
  pickImage: () => Promise<string | null>;
};

function Tool({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="cms-tool"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      // Keep the selection in the editor while clicking the toolbar.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function LinkForm({
  editor,
  t,
  onDone,
}: {
  editor: Editor;
  t: EditorText;
  onDone: () => void;
}) {
  const current =
    (editor.getAttributes("link").href as string | undefined) ?? "";
  const [href, setHref] = useState(current);
  const ok = linkAllowed(href.trim());
  return (
    <form
      className="cms-link-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        editor
          .chain()
          .focus()
          .extendMarkRange("link")
          .setLink({ href: href.trim() })
          .run();
        onDone();
      }}
    >
      <Input
        autoFocus
        aria-label={t.linkLabel}
        placeholder="https://… /pfad #anker mailto:…"
        value={href}
        maxLength={LIMITS.href}
        onChange={(e) => setHref(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
        }}
        aria-invalid={href.trim() !== "" && !ok}
      />
      <Button type="submit" size="sm" disabled={!ok}>
        {t.linkApply}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onDone}>
        {t.cancel}
      </Button>
      {href.trim() !== "" && !ok && (
        <span className="field-hint">{t.linkRule}</span>
      )}
    </form>
  );
}

function Toolbar({
  editor,
  t,
  pickImage,
}: {
  editor: Editor;
  t: EditorText;
  pickImage: CanvasProps["pickImage"];
}) {
  const [linkOpen, setLinkOpen] = useState(false);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      h4: e.isActive("heading", { level: 4 }),
      paragraph: e.isActive("paragraph"),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      code: e.isActive("code"),
      link: e.isActive("link"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      callout: e.isActive("callout"),
      tone: (e.getAttributes("callout").tone as string | undefined) ?? null,
      codeBlock: e.isActive("codeBlock"),
      image: e.isActive("orbitImage"),
      caption:
        (e.getAttributes("orbitImage").caption as string | null | undefined) ??
        "",
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const c = () => editor.chain().focus();
  return (
    <div className="cms-toolbar" role="toolbar" aria-label={t.toolbar}>
      <div className="cms-toolbar-row">
        <Tool
          label={t.tools.paragraph}
          active={state.paragraph}
          onClick={() => c().setParagraph().run()}
        >
          <Pilcrow />
        </Tool>
        <Tool
          label={t.tools.h2}
          active={state.h2}
          onClick={() => c().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 />
        </Tool>
        <Tool
          label={t.tools.h3}
          active={state.h3}
          onClick={() => c().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 />
        </Tool>
        <Tool
          label={t.tools.h4}
          active={state.h4}
          onClick={() => c().toggleHeading({ level: 4 }).run()}
        >
          <Heading4 />
        </Tool>
        <span className="cms-toolbar-sep" aria-hidden="true" />
        <Tool
          label={t.tools.bold}
          active={state.bold}
          onClick={() => c().toggleBold().run()}
        >
          <Bold />
        </Tool>
        <Tool
          label={t.tools.italic}
          active={state.italic}
          onClick={() => c().toggleItalic().run()}
        >
          <Italic />
        </Tool>
        <Tool
          label={t.tools.code}
          active={state.code}
          onClick={() => c().toggleCode().run()}
        >
          <Code />
        </Tool>
        <Tool
          label={t.tools.link}
          active={state.link || linkOpen}
          onClick={() => setLinkOpen((v) => !v)}
        >
          <LinkIcon />
        </Tool>
        {state.link && (
          <Tool
            label={t.tools.unlink}
            onClick={() => c().extendMarkRange("link").unsetLink().run()}
          >
            <Unlink />
          </Tool>
        )}
        <span className="cms-toolbar-sep" aria-hidden="true" />
        <Tool
          label={t.tools.bullet}
          active={state.bullet}
          onClick={() => c().toggleBulletList().run()}
        >
          <List />
        </Tool>
        <Tool
          label={t.tools.ordered}
          active={state.ordered}
          onClick={() => c().toggleOrderedList().run()}
        >
          <ListOrdered />
        </Tool>
        <Tool
          label={t.tools.quote}
          active={state.quote}
          onClick={() => c().toggleBlockquote().run()}
        >
          <Quote />
        </Tool>
        <Tool
          label={t.tools.callout}
          active={state.callout}
          onClick={() =>
            state.callout
              ? c().lift("callout").run()
              : c().wrapIn("callout", { tone: "info" }).run()
          }
        >
          <Info />
        </Tool>
        <Tool
          label={t.tools.codeBlock}
          active={state.codeBlock}
          onClick={() => c().toggleCodeBlock().run()}
        >
          <SquareCode />
        </Tool>
        <Tool
          label={t.tools.divider}
          onClick={() => {
            // Lists, quotes and callouts hold no dividers: it goes after them.
            const { $from } = editor.state.selection;
            if (containerDepth($from) > 0)
              c()
                .insertContentAt($from.after(1), { type: "horizontalRule" })
                .run();
            else c().setHorizontalRule().run();
          }}
        >
          <Minus />
        </Tool>
        <Tool
          label={t.tools.image}
          onClick={async () => {
            const assetId = await pickImage();
            if (!assetId) return;
            const image = {
              type: "orbitImage",
              attrs: { assetId, caption: null },
            };
            // Lists, quotes and callouts hold no images: it goes after them.
            const { $from } = editor.state.selection;
            if (containerDepth($from) > 0)
              c().insertContentAt($from.after(1), image).run();
            else c().insertContent(image).run();
          }}
        >
          <ImagePlus />
        </Tool>
        <span className="cms-toolbar-sep" aria-hidden="true" />
        <Tool
          label={t.tools.undo}
          disabled={!state.canUndo}
          onClick={() => c().undo().run()}
        >
          <Undo2 />
        </Tool>
        <Tool
          label={t.tools.redo}
          disabled={!state.canRedo}
          onClick={() => c().redo().run()}
        >
          <Redo2 />
        </Tool>
      </div>
      {linkOpen && (
        <LinkForm editor={editor} t={t} onDone={() => setLinkOpen(false)} />
      )}
      {state.callout && (
        <div className="cms-toolbar-row">
          <label className="field-hint" htmlFor="cms-callout-tone">
            {t.calloutTone}
          </label>
          <select
            id="cms-callout-tone"
            className="input"
            value={state.tone ?? "info"}
            onChange={(e) =>
              c().updateAttributes("callout", { tone: e.target.value }).run()
            }
          >
            {CALLOUT_TONES.map((tone) => (
              <option key={tone} value={tone}>
                {t.tones[tone]}
              </option>
            ))}
          </select>
        </div>
      )}
      {state.image && (
        <div className="cms-toolbar-row">
          <label className="field-hint" htmlFor="cms-image-caption">
            {t.caption}
          </label>
          <Input
            id="cms-image-caption"
            value={state.caption ?? ""}
            maxLength={LIMITS.caption}
            onChange={(e) =>
              editor
                .chain()
                .updateAttributes("orbitImage", {
                  caption: e.target.value || null,
                })
                .run()
            }
          />
        </div>
      )}
    </div>
  );
}

export default function Canvas({
  initial,
  editable,
  t,
  srcOf,
  onChange,
  onPaste,
  pickImage,
}: CanvasProps) {
  // The callbacks change on every render of the page; the editor keeps the first.
  const latest = useRef({ onChange, onPaste });
  latest.current = { onChange, onPaste };
  const editor = useEditor({
    extensions: editorExtensions({ placeholder: t.placeholder, srcOf }),
    content: initial as JSONContent,
    editable,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "cms-prose",
        "aria-label": t.bodyLabel,
        "aria-multiline": "true",
        role: "textbox",
      },
      transformPastedHTML: (html) => {
        const { html: out, notice } = normalizePastedHtml(html);
        if (notice.images || notice.links) latest.current.onPaste(notice);
        return out;
      },
    },
    onUpdate: ({ editor: e }) => {
      const replacement = latest.current.onChange(e.getJSON() as TiptapNode);
      if (replacement)
        e.commands.setContent(replacement as JSONContent, {
          emitUpdate: false,
        });
    },
  });
  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);
  if (!editor) return <div className="cms-canvas cms-canvas-loading" />;
  return (
    <div className="cms-canvas">
      {editable && <Toolbar editor={editor} t={t} pickImage={pickImage} />}
      <EditorContent editor={editor} />
    </div>
  );
}
