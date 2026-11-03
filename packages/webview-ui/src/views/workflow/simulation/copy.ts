/** What a simulated run did, said the same way over the canvas and in the run summary. */
export function simulatedNote(running: boolean): string {
  return running
    ? 'Nothing is executed. Blocks return the mocks of the simulation file.'
    : 'Nothing was executed. Results come from the simulation file.';
}
