export function turnReasoning(steps, current) {
  const members = steps.length ? steps : [current]
  if (members.find(step => stepReasoning(step) !== '')?.step !== current.step) return ''
  return members.map(stepReasoning).filter(Boolean).join('\n\n')
}

const stepReasoning = step => step.blocks.filter(block => block.kind === 'reasoning').map(block => block.text).join('\n').trim()
