// 项目/对话树的行规格：移植自 BranchedMenu（reactbits.dev）的视觉语法。
//
// 那是网页组件：左轨贯穿全树，项目头坐在轨道上，会话从轨道经圆角弯出，
// 通向当前项的分支用强调色描画（"reach 线"），活动分组旁的轨道上亮着滑动标记。
// 终端没有曲线与过渡，用箱线字符和颜色层级表达同一结构：
//   左轨 `│` 每行贯通；末个子项用圆弯 `╰─`（对应 radius），其余 `├─`；
//   当前会话的整条分支与标签用 accent——这是 reach 线的静态等价物
//   （终端无颜色过渡，即 web 版 prefers-reduced-motion 的形态）；
//   开放且含当前会话的分组，轨道亮 `▎`——滑动 marker 的静态等价物。
// 键盘选中不用前缀符号：有背景色能力时整行铺 selectedBg；
// 没有时轨道字符降级为 `›`（宽度不变，树形不破）。

/** 一行的渲染规格：字符与主题 token 分开给，着色归调用方（它才知道 theme）。 */
export type BranchedSpec = {
  /** col0 字符：左轨 `│`、活动分组标记 `▎`、无背景时的选中降级 `›`。 */
  rail: '│' | '▎' | '›';
  railToken: string;
  /** 会话行的分支（`├─`/`╰─`）；分组头为空串。 */
  branch: string;
  branchToken: string;
  labelToken: string;
  /** 选中态由调用方决定怎么铺（背景色或降级标记），这里只如实上报。 */
  selected: boolean;
};

export type BranchedRowInput = {
  kind: 'project' | 'session';
  path: string;
  label: string;
};

export function branchedSpec(input: {
  row: BranchedRowInput;
  /** 是否该分组在该会话之后的最后一个子项（决定圆弯还是分叉）。 */
  isLastChild: boolean;
  /** 分组头是否处于展开态（会话行恒为 true，无意义）。 */
  open: boolean;
  /** 分组头展开且其下含当前会话：轨道亮标记。 */
  holdsActive: boolean;
  /** 会话行：是否是当前正在查看的会话。 */
  active: boolean;
  selected: boolean;
  /** 终端/主题是否支持背景色（决定选中态走高亮还是降级标记）。 */
  supportsBg: boolean;
}): BranchedSpec {
  const { row, open, holdsActive, active, selected, supportsBg } = input;
  // 选中降级：没有背景色就用轨道列放 `›`——占的是标记位，不加宽度。
  if (selected && !supportsBg) {
    return { rail: '›', railToken: 'accent', branch: '', branchToken: 'borderMuted', labelToken: row.kind === 'session' ? (active ? 'accent' : 'dim') : open ? 'text' : 'dim', selected };
  }
  if (row.kind === 'project') {
    return {
      rail: open && holdsActive ? '▎' : '│',
      railToken: open && holdsActive ? 'accent' : 'dim',
      branch: '', branchToken: 'borderMuted',
      labelToken: open ? 'text' : 'dim',
      selected,
    };
  }
  return {
    rail: '│', railToken: 'dim',
    branch: input.isLastChild ? '╰─' : '├─',
    branchToken: active ? 'accent' : 'borderMuted',
    labelToken: active ? 'accent' : 'dim',
    selected,
  };
}
