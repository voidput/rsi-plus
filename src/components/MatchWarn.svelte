<script lang="ts">
  /**
   * Warning mark on a hangar ship RSI+ could not match to RSI's ship catalog exactly: a stand-in (`CatalogShip.near`,
   * data borrowed from a hull of the same line) or no match at all. The hover says what was assumed and asks for a
   * debug file (Settings → Debug) on the Discord, so a wrong ship gets reported instead of trusted.
   */
  import HintBadge from './HintBadge.svelte';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { DISCORD_URL } from '@/lib/support';

  let { name, near = null }: { name: string; near?: string | null } = $props();
  const where = DISCORD_URL ? `the RSI+ Discord (${DISCORD_URL})` : 'the RSI+ Discord';
  const hint = $derived(
    (near
      ? `RSI's ship catalog has no ${name}. Maker, role, MSRP, picture and paints are taken from the ${near}, the closest hull it lists.`
      : `RSI's ship catalog has no ship called ${name}, so it has no paints, MSRP or compare here.`) +
      `\n\nIf that's wrong: Settings → Debug → Export debug file, and post it in ${where} with the ship's name.`,
  );
</script>

<HintBadge variant="warning-soft" size="xs" {hint} aria-label={`${name}: not matched exactly. ${hint}`}><TriangleAlert /></HintBadge>
