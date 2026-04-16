from django.test import TestCase

from apps.catalog.models import CatalogItem
from apps.inventory.models import InventoryEvent
from apps.inventory.services import (
    apply_manual_adjustment,
    calculate_stock_balance,
    record_inventory_event,
    reserve_inventory,
)


class InventoryServiceTests(TestCase):
    def setUp(self):
        self.item = CatalogItem.objects.create(
            internal_sku="SET-10274-NEW-SEALED",
            kind=CatalogItem.Kind.SET,
            title="Ghostbusters ECTO-1",
            sealed=True,
        )

    def test_stock_balance_uses_events_and_reservations(self):
        record_inventory_event(
            item=self.item,
            event_type=InventoryEvent.EventType.RECEIVED,
            quantity_delta=10,
        )
        reserve_inventory(
            item=self.item,
            reserved_quantity=3,
            reservation_key="order-1",
        )

        balance = calculate_stock_balance(item=self.item)

        self.assertEqual(balance.on_hand, 10)
        self.assertEqual(balance.reserved, 3)
        self.assertEqual(balance.available, 7)

    def test_inventory_events_support_idempotency(self):
        first = record_inventory_event(
            item=self.item,
            event_type=InventoryEvent.EventType.RECEIVED,
            quantity_delta=2,
            idempotency_key="receipt-1",
        )
        second = record_inventory_event(
            item=self.item,
            event_type=InventoryEvent.EventType.RECEIVED,
            quantity_delta=2,
            idempotency_key="receipt-1",
        )

        self.assertEqual(first.pk, second.pk)
        self.assertEqual(InventoryEvent.objects.count(), 1)

    def test_manual_adjustment_updates_on_hand(self):
        record_inventory_event(
            item=self.item,
            event_type=InventoryEvent.EventType.RECEIVED,
            quantity_delta=5,
        )
        apply_manual_adjustment(item=self.item, quantity_delta=-1, reference_id="cycle-count")

        balance = calculate_stock_balance(item=self.item)

        self.assertEqual(balance.on_hand, 4)
