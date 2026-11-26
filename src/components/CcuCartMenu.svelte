<script lang="ts">
  /**
   * Cart control for a CCU SKU on the Ship catalog. RSI adds an upgrade only *from* a ship, so the button opens a
   * pick of the hulls you own that are cheaper than the target (most expensive first: the smallest step), each with
   * what the upgrade costs from it (SKU price − that hull's MSRP). Picking one adds it (`addUpgrade`: RSI checks the
   * pair and prices it; nothing is paid). No hull of yours below it → *Plan CCU* instead.
   */
  import * as DropdownMenu from '@/components/ui/dropdown-menu';
  import TipButton from './TipButton.svelte';
  import CartButton from './CartButton.svelte';
  import ShoppingCart from '@lucide/svelte/icons/shopping-cart';
  import { addUpgrade } from '@/lib/cart';
  import type { createCartLedger } from '@/lib/cart-ui.svelte';
  import { usd, type CatalogShip, type Sku } from '@/lib/store';

  let { to, sku, from, cart, label }: { to: CatalogShip; sku: Sku; from: CatalogShip[]; cart: ReturnType<typeof createCartLedger>; label: string } = $props();
  /** One ledger key per target SKU: the last pick shows its state. */
  const key = $derived(`ccu:${sku.id}`);
  let picked = $state<CatalogShip | null>(null);
  const add = (f: CatalogShip) => {
    picked = f;
    void cart.add(key, () => addUpgrade({ fromShipId: f.id, toShipId: to.id, toSkuId: sku.id }), sku.id);
  };
</script>

{#if cart.of(key)}
  <CartButton state={cart.of(key)} onadd={() => picked && add(picked)} name={`${label}${picked ? ` from ${picked.name}` : ''}`} available={sku.available} />
{:else}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <TipButton {...props} variant="ghost" size="icon-xs" class="text-primary size-6" disabled={!sku.available} tip={from.length ? `Add this CCU to ${to.name} to your RSI cart: pick the ship to upgrade from` : `No ship of yours costs less than the ${to.name}: plan a chain instead`} aria-label={`Add ${label} to cart`}><ShoppingCart class="size-3.5" /></TipButton>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start" class="max-h-80 w-72 overflow-y-auto">
      <DropdownMenu.Label class="text-muted-foreground text-[11px] font-normal">{label} — upgrade from</DropdownMenu.Label>
      {#each from as f (f.id)}
        <DropdownMenu.Item onclick={() => add(f)}>
          <span class="flex-1 truncate">{f.name}</span>
          <span class="text-muted-foreground tabular-nums text-xs">{usd(Math.max(0, sku.price - f.msrp))}</span>
        </DropdownMenu.Item>
      {:else}
        <DropdownMenu.Item disabled>No hull of yours is cheaper (load Pledges first?)</DropdownMenu.Item>
      {/each}
      <DropdownMenu.Separator />
      <DropdownMenu.Item onclick={() => (location.hash = `#ccu?to=${to.id}`)}>Plan CCU → {to.name}</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
