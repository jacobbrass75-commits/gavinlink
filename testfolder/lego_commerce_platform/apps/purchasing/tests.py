from decimal import Decimal

from django.test import TestCase

from apps.catalog.models import CatalogItem
from apps.inventory.models import InventoryEvent
from apps.inventory.services import calculate_stock_balance
from apps.purchasing.services import create_purchase, intake_purchase


class PurchasingServiceTests(TestCase):
    def test_intake_purchase_creates_lines_lot_and_receipt_event(self):
        item = CatalogItem.objects.create(
            internal_sku="MINIFIG-SW0001-USED-COMPLETE",
            kind=CatalogItem.Kind.MINIFIG,
            title="Luke Skywalker",
        )
        purchase = create_purchase(
            source_name="Local Lot",
            source_reference="FBM-1001",
            merchandise_cost=Decimal("12.00"),
        )

        created_lines = intake_purchase(
            purchase=purchase,
            line_items=[
                {
                    "item": item,
                    "quantity": 3,
                    "unit_cost": Decimal("4.00"),
                }
            ],
        )

        self.assertEqual(len(created_lines), 1)
        self.assertEqual(purchase.lines.count(), 1)
        self.assertEqual(item.inventory_lots.count(), 1)
        self.assertEqual(
            InventoryEvent.objects.filter(event_type=InventoryEvent.EventType.RECEIVED).count(),
            1,
        )
        self.assertEqual(calculate_stock_balance(item=item).on_hand, 3)
