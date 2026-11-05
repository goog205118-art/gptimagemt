// Editable starting templates from the user-provided prompt document.
export const PROMPT_PRESET_SEED_VERSION = 1;
export const PROMPT_PRESET_SEEDS = [
  {
    id: 'canvas-01',
    name: '多机位九宫格',
    category: '角色',
    prompt:
      'A multi-camera angle reference sheet in 3x3 grid layout, showing [主体] from 9 different perspectives simultaneously: top-left front view, top-center 3/4 front view, top-right side profile, middle-left low angle, middle-center eye-level straight-on, middle-right high angle, bottom-left back view, bottom-center 3/4 back view, bottom-right top-down overhead view. [主体详细描述]. Consistent lighting across all 9 frames, uniform light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, professional studio photography, clean grid layout with thin white dividers between frames, character consistency maintained across all angles, absolutely no visible numbers text labels frame counters corner marks or annotations anywhere on the image',
    negative:
      'numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, bad anatomy, distorted face, extra fingers, deformed hands, inconsistent character design, lighting mismatch between frames, blurry, low quality, cropped, out of frame',
    notes: '同一主体/场景，9个不同机位/角度同时呈现，用于角色多角度参考、产品展示、空间勘测',
    kind: 'prompt',
    source: '用户提供的无限画布提示词文档',
    createdAt: 0,
  },
  {
    id: 'canvas-02',
    name: '多机位九宫格4K',
    category: '分镜',
    prompt:
      'Ultra high resolution multi-camera angle reference sheet in 3x3 grid layout, 4K quality, showing [主体] from 9 different perspectives simultaneously: top-left front view, top-center 3/4 front view, top-right side profile, middle-left low angle, middle-center eye-level straight-on, middle-right high angle, bottom-left back view, bottom-center 3/4 back view, bottom-right top-down overhead view. [主体详细描述]. Consistent cinematic lighting across all 9 frames, uniform light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, professional studio photography with medium format film aesthetic, clean grid layout with thin white dividers between frames, character consistency maintained across all angles, fine organic film grain, zero digital sharpening, absolutely no visible numbers text labels frame counters corner marks or annotations anywhere on the image',
    negative:
      'numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, bad anatomy, distorted face, extra fingers, deformed hands, inconsistent character design, lighting mismatch between frames, blurry, low quality, cropped, out of frame, digital sharpening, oversharpened, plastic skin, over-smoothing',
    notes: '高分辨率版本的多机位九宫格，用于印刷级输出、大屏展示、精细材质参考',
    kind: 'prompt',
    source: '用户提供的无限画布提示词文档',
    createdAt: 0,
  },
  {
    id: 'canvas-03',
    name: '剧情推演四宫格',
    category: '分镜',
    prompt:
      'A 4-panel storyboard sequence in 2x2 grid, showing narrative progression of [事件/场景]: top-left [阶段1描述], top-right [阶段2描述], bottom-left [阶段3描述], bottom-right [阶段4描述]. Consistent character design across all panels, coherent lighting and color palette, uniform light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, cinematic composition, emotional arc from [情绪A] to [情绪B], film grain texture, clean thin white grid dividers, absolutely no visible numbers text labels frame counters corner marks or annotations anywhere on the image',
    negative:
      'numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, bad anatomy, distorted face, extra fingers, deformed hands, inconsistent character design, lighting mismatch between frames, discontinuous action, jump cut feel, blurry, low quality, cropped, out of frame',
    notes: '同一事件的4个连续阶段/情绪递进，用于故事板预览、情绪弧线设计、叙事节奏测试',
    kind: 'prompt',
    source: '用户提供的无限画布提示词文档',
    createdAt: 0,
  },
  {
    id: 'canvas-04',
    name: '角色脸部三视图',
    category: '角色',
    prompt:
      'Character face reference sheet, three views side by side in single row: left panel front view straight-on, center panel 3/4 angle view, right panel side profile view. [角色面部详细描述]. Consistent lighting from 45-degree top-side across all three views, light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, neutral clean backdrop, professional character design sheet, clean linework, subtle skin texture, identical facial features maintained across all angles, absolutely no visible numbers text labels frame counters corner marks or annotations anywhere on the image',
    negative:
      'numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, bad anatomy, distorted face, asymmetrical eyes, crossed eyes, extra fingers, deformed hands, inconsistent facial features between panels, lighting mismatch, blurry, low quality, cropped, out of frame',
    notes: '角色面部正面/侧面/四分之三侧面的设定参考，用于Actor ID锁定、表情一致性控制',
    kind: 'prompt',
    source: '用户提供的无限画布提示词文档',
    createdAt: 0,
  },
  {
    id: 'canvas-05',
    name: '产品三视图',
    category: '产品',
    prompt:
      'Product design reference sheet, three orthographic views in single row: front view, side view, top view. [产品详细描述]. Light warm gray background color F0EDE8, products softly blending with background with natural edge transition, no hard edges no white halo no light bleed, studio lighting with soft shadows, technical drawing aesthetic, precise proportions, material texture visible, no perspective distortion, professional product photography, absolutely no visible numbers text labels frame counters corner marks or annotations anywhere on the image',
    negative:
      'numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, distorted proportions, perspective distortion, blurry, low quality, cropped, out of frame, cluttered background, random objects, inconsistent material texture between views',
    notes: '产品设计的正面/侧面/顶面展示，用于工业设计、电商详情、技术文档',
    kind: 'prompt',
    source: '用户提供的无限画布提示词文档',
    createdAt: 0,
  },
  {
    id: 'canvas-06',
    name: '25宫格连贯分镜',
    category: '分镜',
    prompt:
      'A 5x5 cinematic storyboard grid, 25 sequential frames showing continuous narrative flow of [主体/场景/动作], naturally divided into 9 story beats progressing through beginning, development, escalation, twist, climax, and resolution. Scene transitions conveyed purely through visual continuity and character motion, absolutely no visible numbers, text, labels, frame counters, corner marks, or annotations anywhere on the image. Consistent character and environment across all 25 frames, smooth motion continuity between adjacent frames, uniform cinematic lighting and color palette, light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, varied shot progression from wide to close-up, professional film storyboard aesthetic, subtle film grain, clean thin white grid dividers',
    negative:
      'numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, bad anatomy, distorted face, extra fingers, deformed hands, inconsistent character design, lighting mismatch between frames, discontinuous action, jump cut feel, blurry, low quality, cropped, out of frame, different hairstyle between frames, different clothing between frames',
    notes:
      '完整场景/动作的25帧连续分镜，5×5网格承载9个叙事节拍，用于电影分镜预览、动作连贯性测试、Seedance分段参考',
    kind: 'prompt',
    source: '用户提供的无限画布提示词文档',
    createdAt: 0,
  },
  {
    id: 'canvas-07',
    name: '电影级光影校正',
    category: '光影',
    prompt:
      'Cinematic lighting comparison sheet, 6 panels showing the same [主体/场景] under different lighting conditions: top-left golden hour warm backlight, top-center overcast soft diffused light, top-right neon night city light, bottom-left harsh midday direct sun, bottom-center Rembrandt 45-degree side light with triangle shadow, bottom-right dramatic low-key chiaroscuro. Consistent composition and subject across all panels, only lighting changes, light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, professional cinematography reference, absolutely no visible numbers text labels frame counters corner marks or annotations anywhere on the image',
    negative:
      'numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, inconsistent subject between panels, different pose between panels, different costume between panels, cluttered background, blurry, low quality, cropped, out of frame',
    notes: '同一场景在不同光影条件下的对比展示，用于灯光方案测试、色调选择、情绪对照',
    kind: 'prompt',
    source: '用户提供的无限画布提示词文档',
    createdAt: 0,
  },
  {
    id: 'canvas-08',
    name: '角色设定参考表（胸口特写+全身三视图）',
    category: '角色',
    prompt:
      'Character reference sheet, left-right split layout: left one-third area is chest-up close-up front view portrait (shoulder-up framing, extreme facial detail clarity, gentle natural expression, bright eyes looking straight at camera, realistic skin texture with visible pores and subtle imperfections, refined classical makeup); right two-thirds area is three full-body views in horizontal row, from left to right: full-body front standing pose (arms hanging naturally, feet together, complete front costume and body proportions), full-body side profile view (weight slightly shifted, waist-hip curve and silhouette visible, complete side costume and footwear), full-body back view (complete back neckline, hairstyle from behind, back costume details). Consistent front-top-side lighting across all panels, soft diffused light quality, light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, identical character design, costume, hairstyle and accessories across all panels, professional character design sheet style, clean edges, accurate proportions, material texture visible from all angles, absolutely no visible numbers, text, labels, frame counters, corner marks or annotations anywhere on the image',
    negative:
      'numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, dividing line labels, panel markers, bad anatomy, distorted face, extra fingers, deformed hands, inconsistent character design, lighting mismatch between frames, different hairstyle between panels, different clothing between panels, blurry, low quality, cropped, out of frame, asymmetrical eyes, crossed eyes, plastic skin, over-smoothing, textureless skin, uniform skin tone, digital sharpening, filter look, CG look, retouched, airbrushed, multiple heads, mutated limbs, floating limbs, disconnected limbs, uneven panel sizes, broken layout',
    notes:
      '角色一致性设定参考：左侧1/3脸部大特写锚定面部，右侧2/3三格横排全身三视图（正/侧/背）锚定服装与身形，用于Actor ID锁定、服装一致性控制、Seedance Canvas故事板',
    kind: 'prompt',
    source: '用户提供的无限画布提示词文档',
    createdAt: 0,
  },
  {
    id: 'canvas-09',
    name: '6种基础表情胸像（2×3六宫格）',
    category: '角色',
    prompt:
      'Character expression reference sheet in 2x3 grid layout, six basic expressions of the same character: top row from left to right: calm neutral expression (relaxed face, eyes looking straight ahead, lips naturally closed), gentle smile (corners of mouth slightly raised, eyes with smile lines, warm and approachable), joyful laugh (eyebrows and eyes curved upward, mouth open showing teeth, exuberant happiness); bottom row from left to right: sad tearful expression (slight furrow between brows, downturned outer eye corners, tears welling in eyes about to fall), angry stern expression (brows tightly locked, sharp piercing eyes with pressure, jaw slightly set), surprised astonished expression (eyes wide open, eyebrows raised high, mouth slightly open in O shape). All six expressions are chest-up close-up portraits of the same character, shoulder-up framing, extreme facial detail clarity, realistic skin texture preserved, no additional light source, light warm gray background color F0EDE8, subjects softly blending with background with natural edge transition, no hard edges no white halo no light bleed, identical character styling, hairstyle, makeup and accessories across all six panels, only facial expression changes, professional character expression sheet style, clean edges, absolutely no visible numbers, text, labels, frame counters, corner marks or annotations anywhere on the image',
    negative:
      'numbers, text, letters, labels, frame numbers, corner marks, annotations, captions, watermarks, signatures, logos, readable text, font, typography, grid numbers, sequence markers, page numbers, index, expression name labels, emotion text, hard edge, glowing edge, white halo, light bleed, overexposed edge, cutout look, pasted on background, floating subject, disconnected shadow, pure white background, stark white, cold gray, bad anatomy, distorted face, extra fingers, deformed hands, inconsistent character design, different hairstyle between panels, different clothing between panels, lighting mismatch between panels, blurry, low quality, cropped, out of frame, asymmetrical eyes, crossed eyes, plastic skin, over-smoothing, textureless skin, uniform skin tone, digital sharpening, filter look, CG look, retouched, airbrushed, multiple heads, mutated limbs, floating limbs, disconnected limbs, uneven panel sizes, broken layout, extra rows, extra columns, missing panel, shadows on face, directional light, dramatic lighting, colored light',
    notes:
      '同一角色六种基础表情同时呈现，用于表情一致性控制、情绪基准设定、Seedance Talk to Edit表情参考',
    kind: 'prompt',
    source: '用户提供的无限画布提示词文档',
    createdAt: 0,
  },
  {
    id: 'canvas-10',
    name: '360全景图',
    category: '视角',
    prompt:
      '生成一个720度的全景VR图，左右边缘100%像素级无缝衔接，可无限循环拼接；上下极点(南北极)自然过渡，无明显断层或拉伸，场景一致性，以及场景的逻辑性，封闭场景需要有门',
    negative:
      'seam, visible seam, hard seam, broken panorama, discontinuous edge, mismatched left and right edges, distorted poles, stretched ceiling, stretched floor, warped horizon, inconsistent scene logic, impossible space, no exit in closed room, text, letters, labels, watermark, logo, blurry, low quality',
    notes:
      '用于生成360全景、VR全景、可左右循环拼接的空间视角图，适合室内空间、展厅、场景漫游、环境概念设计；封闭场景需要具备合理出入口。',
    kind: 'prompt',
    source: '用户提供的无限画布提示词文档',
    createdAt: 0,
  },
];
